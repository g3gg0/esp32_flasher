"""Generate GPIO profiles and complete register-name catalogs from ESP-IDF headers.

No compiler/eval is used. Only integer C expressions understood by the small AST
interpreter are resolved; parameterized/unknown expressions remain symbolic.
"""
import ast
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REF = "v5.5.1"
CHIPS = ["esp32", "esp32s2", "esp32s3", "esp32c2", "esp32c3", "esp32c5", "esp32c6", "esp32c61", "esp32h2", "esp32p4"]

# Memory pins must never be remuxed while the ROM/stub is using them. Include
# package-dependent octal-memory pins conservatively; raw chip view keeps these
# exclusions. Board profiles can add constraints, never silently remove them.
MEMORY = {
    "esp32": [6, 7, 8, 9, 10, 11, 16, 17],
    "esp32s2": list(range(26, 33)),
    "esp32s3": list(range(26, 38)),
    "esp32c2": list(range(11, 18)),
    "esp32c3": list(range(12, 18)),
    "esp32c5": list(range(15, 23)),
    "esp32c6": [10, 11] + list(range(24, 31)),
    "esp32c61": list(range(14, 22)),
    "esp32h2": list(range(15, 22)),
    "esp32p4": [],
}
STRAPS = {
    "esp32": [0, 2, 5, 12, 15], "esp32s2": [0, 45, 46],
    "esp32s3": [0, 3, 45, 46], "esp32c2": [8, 9],
    "esp32c3": [2, 8, 9], "esp32c5": [2, 3, 7, 25, 26, 27, 28],
    "esp32c6": [4, 5, 8, 9, 15], "esp32c61": [3, 4, 7, 8, 9],
    "esp32h2": [8, 9, 25], "esp32p4": [34, 35, 36, 37, 38],
}

def macros(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"\\\n", "", text)
    return {m[1]: m[2].split("//")[0].strip() for m in re.finditer(r"^\s*#define\s+(\w+)[ \t]+(.+)$", text, re.M)}

class Integers:
    def __init__(self, definitions):
        self.definitions, self.cache = definitions, {}

    def name(self, name):
        if name in self.cache:
            return self.cache[name]
        if re.fullmatch(r"BIT\d+", name):
            return 1 << int(name[3:])
        value = self.expression(self.definitions[name])
        self.cache[name] = value
        return value

    def expression(self, expression):
        expression = re.sub(r"\b(0[xX][0-9a-fA-F]+|[0-9]+)(?:ULL|LLU|UL|LU|LL|U|L)\b", r"\1", expression)
        return self.node(ast.parse(expression, mode="eval").body)

    def node(self, node):
        if isinstance(node, ast.Constant) and type(node.value) is int:
            return node.value
        if isinstance(node, ast.Name):
            return self.name(node.id)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("BIT", "BIT64"):
            return 1 << self.node(node.args[0])
        if isinstance(node, ast.UnaryOp):
            value = self.node(node.operand)
            if isinstance(node.op, ast.Invert): return ~value
            if isinstance(node.op, ast.USub): return -value
            if isinstance(node.op, ast.UAdd): return value
        if isinstance(node, ast.BinOp):
            left, right = self.node(node.left), self.node(node.right)
            operations = {ast.Add: lambda: left + right, ast.Sub: lambda: left - right,
                          ast.Mult: lambda: left * right, ast.LShift: lambda: left << right,
                          ast.RShift: lambda: left >> right, ast.BitOr: lambda: left | right,
                          ast.BitAnd: lambda: left & right, ast.BitXor: lambda: left ^ right}
            if type(node.op) in operations:
                return operations[type(node.op)]()
        raise ValueError(ast.dump(node))

def generate(chip):
    folder = ROOT / "reference" / chip
    headers = {p.name: p.read_text(encoding="utf-8") for p in sorted(folder.glob("*.h"))}
    definitions = {}
    # Order puts the actual register/IO-mux definitions after compatibility names.
    for text in headers.values(): definitions.update(macros(text))
    numbers = Integers(definitions)
    n = numbers.name
    optional = lambda name: n(name) if name in definitions else None
    pin_count = n("SOC_GPIO_PIN_COUNT")
    valid_mask, output_mask = n("SOC_GPIO_VALID_GPIO_MASK"), n("SOC_GPIO_VALID_OUTPUT_GPIO_MASK")
    uart = [n("U0TXD_GPIO_NUM"), n("U0RXD_GPIO_NUM")]
    usb = sorted({n(key) for key in definitions if re.fullmatch(r"USB_\w*(?:DM|DP)_GPIO_NUM", key)})
    # S2 names the OTG pins differently and has no Serial/JTAG header macros.
    if chip == "esp32s2": usb = [19, 20]
    memory = set(MEMORY[chip])
    memory.update(n(key) for key in definitions if key.startswith("MSPI_IOMUX_PIN_NUM_"))
    pins = []
    for pin in range(pin_count):
        if not valid_mask & (1 << pin): continue
        reasons = []
        if pin in memory: reasons.append("Flash / PSRAM / package-dependent memory")
        if pin in uart: reasons.append("UART0 bootloader transport")
        if pin in usb: reasons.append("USB transport / PHY")
        mux_name = f"IO_MUX_GPIO{pin}_REG"
        # Some chips have aliases for nonexistent/unbonded IO pads.
        mux = optional(mux_name)
        if mux is None: reasons.append("No digital IO-MUX register")
        item = {"id": pin, "mux": mux, "output": bool(output_mask & (1 << pin)),
                "pulls": chip != "esp32" or pin < 34, "reserved": "; ".join(reasons),
                "strap": pin in STRAPS[chip], "digitalRoute": []}
        pins.append(item)

    # GPIO0..7/15 can belong to the independent LP domain. Route back to HP GPIO.
    for pin in pins:
        index = pin["id"]
        if chip in ("esp32c6", "esp32c5", "esp32c61") and index < (8 if chip == "esp32c6" else 7):
            pin["digitalRoute"].append({"address": n("LP_AON_GPIO_MUX_REG"), "mask": 1 << index})
        elif chip == "esp32h2" and 7 <= index <= 14:
            pin["digitalRoute"].append({"address": n("LP_AON_GPIO_MUX_REG"), "mask": 1 << (index - 7)})
        elif chip == "esp32p4" and index < 16:
            # v5.5.1 spells the PAD12 register macro PAD120 (offset 0x38).
            register = "LP_IOMUX_PAD120_REG" if index == 12 else f"LP_IOMUX_PAD{index}_REG"
            pin["digitalRoute"].append({"address": n(register), "mask": n(f"LP_IOMUX_REG_PAD{index}_MUX_SEL_M")})

    # Classic ESP32 / S2 / S3: map each RTC descriptor back to digital GPIO.
    rtc_path = folder / "rtc_io_periph.c"
    if chip in ("esp32", "esp32s2", "esp32s3"):
        rtc_source = rtc_path.read_text()
        descriptor = rtc_source[rtc_source.index("const rtc_io_desc_t"):]
        gpio_order = ([36, 37, 38, 39, 34, 35, 25, 26, 33, 32, 4, 0, 2, 15, 13, 12, 14, 27]
                      if chip == "esp32" else list(range(22)))
        rows = re.findall(r"\{([^{}]+)\}", descriptor)
        for gpio, row in zip(gpio_order, rows):
            fields = [part.strip() for part in row.split(",")]
            target = next((pin for pin in pins if pin["id"] == gpio), None)
            if target:
                target["digitalRoute"].append({"address": n(fields[0]), "mask": n(fields[1])})

    banks = []
    for suffix in ("", "1"):
        if suffix and pin_count <= 32: continue
        banks.append({"input": n(f"GPIO_IN{suffix}_REG"), "output": n(f"GPIO_OUT{suffix}_REG"),
                      "set": n(f"GPIO_OUT{suffix}_W1TS_REG"), "clear": n(f"GPIO_OUT{suffix}_W1TC_REG"),
                      "enable": n(f"GPIO_ENABLE{suffix}_REG"),
                      "enableSet": n(f"GPIO_ENABLE{suffix}_W1TS_REG"), "enableClear": n(f"GPIO_ENABLE{suffix}_W1TC_REG")})
    oen = "OE" if "GPIO_FUNC0_OE_SEL_M" in definitions else "OEN"
    profile = {"id": chip, "name": "ESP32" + ("-" + chip[5:].upper() if chip != "esp32" else ""),
               "source": f"https://github.com/espressif/esp-idf/tree/{REF}/components/soc/{chip}",
               "sourceRef": REF, "pinCount": pin_count, "pins": pins, "uart": uart, "usb": usb,
               "gpio": {"base": n("DR_REG_GPIO_BASE"), "banks": banks,
                        "pinConfig": n("GPIO_PIN0_REG"), "matrix": n("GPIO_FUNC0_OUT_SEL_CFG_REG"),
                        "matrixMask": n("GPIO_FUNC0_OUT_SEL_M") | n("GPIO_FUNC0_OUT_INV_SEL_M") | n(f"GPIO_FUNC0_{oen}_SEL_M") | n(f"GPIO_FUNC0_{oen}_INV_SEL_M"),
                        "matrixGPIO": n("SIG_GPIO_OUT_IDX") | n(f"GPIO_FUNC0_{oen}_SEL_M"),
                        "pinConfigMask": n("GPIO_PIN0_INT_ENA_M") | n("GPIO_PIN0_INT_TYPE_M") | n("GPIO_PIN0_PAD_DRIVER_M") | n("GPIO_PIN0_WAKEUP_ENABLE_M"),
                        "muxMask": n("MCU_SEL_M") | n("FUN_IE_M") | n("FUN_PU_M") | n("FUN_PD_M") | n("SLP_SEL_M"),
                        "muxGPIO": (n("PIN_FUNC_GPIO") << n("MCU_SEL_S")) | n("FUN_IE_M"),
                        "pullUp": n("FUN_PU_M"), "pullDown": n("FUN_PD_M")},
               "peripherals": []}
    # Full register-name catalog: parameterized registers retain their C expression.
    catalog = {"chip": chip, "sourceRef": REF, "blocks": []}
    for filename, text in headers.items():
        if not filename.endswith("_reg.h"): continue
        registers = []
        for match in re.finditer(r"^\s*#define\s+(\w+_REG)(\([^\n]*?\))?[ \t]+([^\n]+)", text, re.M):
            name, params, expression = match.groups()
            expression = expression.split("//")[0].strip()
            item = {"name": name, "expression": expression}
            if params: item["parameters"] = params[1:-1]
            else:
                try: item["address"] = numbers.expression(expression)
                except (KeyError, SyntaxError, ValueError, RecursionError): pass
            registers.append(item)
        if not registers: continue
        block = filename.removesuffix("_reg.h")
        source = f"https://github.com/espressif/esp-idf/blob/{REF}/components/soc/{chip}/register/soc/{filename}"
        catalog["blocks"].append({"id": block, "source": source, "registers": registers})
        profile["peripherals"].append({"id": block, "name": block.upper().replace("_", " "),
                                       "implemented": block == "gpio", "registerCount": len(registers), "source": source})
    profile["capabilities"] = {key: value for key, value in definitions.items() if re.fullmatch(r"SOC_\w+_SUPPORTED", key)}
    profile["referenceHashes"] = {name: hashlib.sha256(text.encode()).hexdigest() for name, text in headers.items()}
    target = ROOT / "configs" / "registers" / f"{chip}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return profile

if __name__ == "__main__":
    profiles = {}
    for chip in CHIPS:
        profiles[chip] = generate(chip)
        print(chip, len(profiles[chip]["pins"]), "pins,", len(profiles[chip]["peripherals"]), "register blocks")
    content = "// Generated by scripts/generate-chip-data.py from Espressif ESP-IDF v5.5.1 (Apache-2.0).\n"
    content += "(function(root) {\n'use strict';\nconst chips = " + json.dumps(profiles, ensure_ascii=False, separators=(",", ":")) + ";\n"
    content += "if (typeof module === 'object' && module.exports) module.exports = chips;\nelse (root.ESPIO ||= {}).chips = chips;\n})(globalThis);\n"
    (ROOT / "configs" / "chips.js").write_text(content, encoding="utf-8")
