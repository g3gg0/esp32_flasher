"""Generate register-only ADC recipes from the pinned ESP-IDF reference headers.

Raw 12-bit measurements, no claim of factory/eFuse calibrated millivolts.
C3 ADC2 is excluded (IDF disables its oneshot use by default).
"""
from pathlib import Path
import hashlib
import json
import re
import runpy

ROOT = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(Path(__file__).with_name("generate-chip-data.py")))
profiles = {}
for chip in ["esp32c3", "esp32c6", "esp32p4", "esp32s3", "esp32h2"]:
    folder = ROOT / "reference" / chip
    definitions = {}
    for file in sorted(folder.glob("*.h")):
        definitions.update(helpers["macros"](file.read_text(encoding="utf-8")))
    n = helpers["Integers"](definitions).name
    def field(register, name):
        return {"address": n(register), "mask": n(name + "_M"), "shift": n(name + "_S")}
    def write(register, *fields):
        mask, value = 0, 0
        for name, data in fields:
            mask |= n(name + "_M")
            value |= (data << n(name + "_S")) & n(name + "_M")
        return {"address": n(register), "value": value, "mask": mask}
    def analog_field(name, value):
        lo, hi = n(name + '_LSB'), n(name + '_MSB')
        return {"register": n(name), "mask": ((1 << (hi - lo + 1)) - 1) << lo, "value": value << lo}
    # Only read eFuse shadow registers; never issue eFuse commands/writes.
    def efuse_field(name):
        table = (folder / 'esp_efuse_table.c').read_text(encoding='utf-8')
        match = re.search(r'static const esp_efuse_desc_t ' + name + r'\[\] = \{\s*\{EFUSE_BLK(\d+), (\d+), (\d+)\}', table)
        block, bit, count = map(int, match.groups())
        base = n({1: 'EFUSE_RD_MAC_SYS_0_REG' if chip == 'esp32p4' else 'EFUSE_RD_MAC_SPI_SYS_0_REG', 2: 'EFUSE_RD_SYS_PART1_DATA0_REG', 10: 'EFUSE_RD_SYS_PART2_DATA0_REG'}[block])
        return {"address": base + bit // 32 * 4, "shift": bit % 32, "bits": count}
    init = []
    if chip == "esp32c3":
        init += [write("SYSTEM_PERIP_CLK_EN0_REG", ("SYSTEM_APB_SARADC_CLK_EN", 1)),
                 write("SYSTEM_PERIP_RST_EN0_REG", ("SYSTEM_APB_SARADC_RST", 0)),
                 {"address": n("ANA_CONFIG_REG"), "value": 0, "mask": n("ANA_I2C_SAR_FORCE_PD")},
                 {"address": n("ANA_CONFIG2_REG"), "value": n("ANA_I2C_SAR_FORCE_PU"), "mask": n("ANA_I2C_SAR_FORCE_PU")},
                 write("RTC_CNTL_SENSOR_CTRL_REG", ("RTC_CNTL_FORCE_XPD_SAR", 3)),
                 write("APB_SARADC_APB_ADC_CLKM_CONF_REG", ("APB_SARADC_CLK_SEL", 2), ("APB_SARADC_CLKM_DIV_NUM", 15), ("APB_SARADC_CLKM_DIV_A", 0), ("APB_SARADC_CLKM_DIV_B", 1))]
    elif chip in ("esp32c6", "esp32h2"):
        power_fields = [("PMU_XPD_PERIF_I2C", 1)]
        if chip == "esp32c6":
            power_fields.insert(0, ("PMU_PERIF_I2C_RSTB", 1))
        init += [write("PCR_SARADC_CONF_REG", ("PCR_SARADC_REG_CLK_EN", 1), ("PCR_SARADC_CLK_EN", 1), ("PCR_SARADC_RST_EN", 0), ("PCR_SARADC_REG_RST_EN", 0)),
                 write("PCR_SARADC_CLKM_CONF_REG", ("PCR_SARADC_CLKM_EN", 1), ("PCR_SARADC_CLKM_SEL", 0), ("PCR_SARADC_CLKM_DIV_NUM", 19 if chip == "esp32h2" else 15), ("PCR_SARADC_CLKM_DIV_A", 0), ("PCR_SARADC_CLKM_DIV_B", 1)),
                 write("PMU_RF_PWC_REG", *power_fields),
                 {"address": n("PWDET_CONF_REG"), "value": (1 << 24) | (1 << 23), "mask": (1 << 24) | (1 << 23)}]
    elif chip == "esp32s3":
        init += [write("SYSTEM_PERIP_CLK_EN0_REG", ("SYSTEM_APB_SARADC_CLK_EN", 1)),
                 write("SYSTEM_PERIP_RST_EN0_REG", ("SYSTEM_APB_SARADC_RST", 0)),
                 write("SENS_SAR_PERI_CLK_GATE_CONF_REG", ("SENS_SARADC_CLK_EN", 1)),
                 write("SENS_SAR_POWER_XPD_SAR_REG", ("SENS_FORCE_XPD_SAR", 3)),
                 write("APB_SARADC_CTRL2_REG", ("APB_SARADC_TIMER_EN", 0)),
                 write("SENS_SAR_MEAS2_MUX_REG", ("SENS_SAR2_PWDET_CCT", 4)),
                 write("APB_SARADC_APB_ADC_ARB_CTRL_REG", ("APB_SARADC_ADC_ARB_GRANT_FORCE", 0),
                       ("APB_SARADC_ADC_ARB_FIX_PRIORITY", 1), ("APB_SARADC_ADC_ARB_RTC_PRIORITY", 1),
                       ("APB_SARADC_ADC_ARB_APB_PRIORITY", 0), ("APB_SARADC_ADC_ARB_WIFI_PRIORITY", 2))]
    else:
        init += [write("HP_SYS_CLKRST_SOC_CLK_CTRL2_REG", ("HP_SYS_CLKRST_REG_ADC_APB_CLK_EN", 1)),
                 write("HP_SYS_CLKRST_PERI_CLK_CTRL23_REG", ("HP_SYS_CLKRST_REG_ADC_CLK_EN", 1)),
                 write("HP_SYS_CLKRST_HP_RST_EN2_REG", ("HP_SYS_CLKRST_REG_RST_EN_ADC", 0)),
                 write("LPPERI_CLK_EN_REG", ("LPPERI_CK_EN_LP_ADC", 1)),
                 write("PMU_RF_PWC_REG", ("PMU_PERIF_I2C_RSTB", 1), ("PMU_XPD_PERIF_I2C", 1)),
                 write("RTCADC_FORCE_WPD_SAR_REG", ("RTCADC_FORCE_XPD_SAR1", 3), ("RTCADC_FORCE_XPD_SAR2", 3)),
                 write("ADC_CTRL_REG_REG", ("ADC_SAR_CLK_GATED", 1), ("ADC_XPD_SAR1_FORCE", 3), ("ADC_XPD_SAR2_FORCE", 3))]
    profile = {"chip": chip, "bits": 12, "max": 4095, "calibrated": False, "attenuation": 3,
               "source": f"https://github.com/espressif/esp-idf/blob/v5.5.1/components/hal/{chip}/include/hal/adc_ll.h",
               "sourceSha256": hashlib.sha256((folder / "adc_ll.h").read_bytes()).hexdigest(),
               "init": init, "channels": {}, "driveStrength": {"mask": n("FUN_DRV_M"), "shift": n("FUN_DRV_S")}}
    for match in re.finditer(r"#define\s+ADC([12])_GPIO(\d+)_CHANNEL\s+(\d+)", (folder / "adc_channel.h").read_text()):
        unit, gpio, channel = map(int, match.groups())
        if chip == "esp32c3" and unit == 2: continue
        profile["channels"][str(gpio)] = {"unit": unit, "channel": channel}
    if chip not in ("esp32p4", "esp32s3"):
        prefix = "APB_SARADC_" + ("SARADC_" if chip in ("esp32c6", "esp32h2") else "")
        profile["init"].append(write("APB_SARADC_CTRL_REG", (prefix + "SAR_CLK_GATED", 1), (prefix + "XPD_SAR_FORCE", 3), (prefix + "SAR_CLK_DIV", 2 if chip == "esp32h2" else 1)))
        timer = prefix + "TIMER_EN"
        profile["init"].append(write("APB_SARADC_CTRL2_REG", (timer, 0)))
        profile['init'].append(write('APB_SARADC_CTRL2_REG', (prefix + 'SAR1_INV', 0)))
        profile["kind"] = "digital-sar"
        profile["sample"] = {"address": n("APB_SARADC_ONETIME_SAMPLE_REG"),
                             "channel": field("APB_SARADC_ONETIME_SAMPLE_REG", prefix + "ONETIME_CHANNEL"),
                             "attenuation": field("APB_SARADC_ONETIME_SAMPLE_REG", prefix + "ONETIME_ATTEN"),
                             "start": n(prefix + "ONETIME_START_M"), "enable": 1 << 31, "disableMask": (1 << 31) | (1 << 30),
                             "clear": n("APB_SARADC_INT_CLR_REG"), "status": n("APB_SARADC_INT_RAW_REG"), "done": 1 << 31,
                             "data": n("APB_SARADC_SAR1DATA_STATUS_REG" if chip in ("esp32c6", "esp32h2") else "APB_SARADC_1_DATA_STATUS_REG")}
        if chip == "esp32h2":
            # XTAL 32 MHz / (19+1) / 2 = 800 kHz SAR clock. adc_oneshot_hal.c
            # requires five SAR cycles after DONE: (floor(1e6/800000)+1)*5 us.
            profile["sample"]["dataDelayUs"] = 10
    else:
        prefix = "SENS" if chip == "esp32s3" else "RTCADC"
        profile["kind"] = "rtc-sar" if chip == "esp32s3" else "lp-sar"
        profile["units"] = {}
        for unit in (1, 2):
            profile["init"].extend([
                write(f"{prefix}_SAR_READER{unit}_CTRL_REG" if chip == "esp32s3" else f"{prefix}_READER{unit}_CTRL_REG",
                      (f"{prefix}_SAR{unit}_CLK_DIV", 1), (f"{prefix}_SAR{unit}_DATA_INV", 0), (f"{prefix}_SAR{unit}_INT_EN", 0)),
                write(f"{prefix}_SAR_MEAS{unit}_MUX_REG" if chip == "esp32s3" else f"{prefix}_MEAS{unit}_MUX_REG",
                      (f"{prefix}_SAR{unit}_" + ("DIG_FORCE" if unit == 1 else "RTC_FORCE"), 0 if unit == 1 or chip == "esp32s3" else 1))])
            control = f"{prefix}_SAR_MEAS{unit}_CTRL2_REG" if chip == "esp32s3" else f"{prefix}_MEAS{unit}_CTRL2_REG"
            profile["units"][str(unit)] = {"control": n(control),
                "start": n(f"{prefix}_MEAS{unit}_START_SAR_M"), "done": n(f"{prefix}_MEAS{unit}_DONE_SAR_M"),
                "force": n(f"{prefix}_MEAS{unit}_START_FORCE_M") | n(f"{prefix}_SAR{unit}_EN_PAD_FORCE_M"),
                "pad": field(control, f"{prefix}_SAR{unit}_EN_PAD"),
                "attenuation": n(f"{prefix}_SAR_ATTEN{unit}_REG" if chip == "esp32s3" else f"{prefix}_ATTEN{unit}_REG"),
                "channelOffset": 2 if chip == "esp32p4" and unit == 2 else 0}
        if chip == "esp32s3":
            profile["units"]["1"]["idle"] = {"address": n("SENS_SAR_SLAVE_ADDR1_REG"), "mask": n("SENS_SARADC_MEAS_STATUS_M")}
            profile["units"]["2"]["invalidMask"] = 0xc000
    analog_init = []
    if chip == 'esp32p4':
        analog_init += [analog_field('I2C_SAR_ADC_ENT_VDD_GRP1', 0), analog_field('I2C_SAR_ADC_DTEST_VDD_GRP1', 0)]
        profile['init'].append(write('ADC_CTRL2_REG', ('ADC_TIMER_EN', 0)))
    elif chip == 'esp32h2':
        analog_init += [analog_field(name, 0) for name in ('I2C_SARADC_DTEST', 'I2C_SARADC_ENT_SAR', 'I2C_SARADC_EN_TOUT_SAR1_BUS')]
    else:
        analog_init += [analog_field(name, 0) for name in ('ADC_SARADC_DTEST_RTC_ADDR', 'ADC_SARADC_ENT_RTC_ADDR', 'ADC_SARADC_ENT_TSENS_ADDR')]
    if chip == 'esp32s3':
        analog_init.append(analog_field('ADC_SARADC_ENCAL_REF_ADDR', 0))
    for unit in ((1,) if chip == 'esp32h2' else (1, 2)):
        prefix_ref = f'ADC_SAR{unit}_' if chip == 'esp32p4' else f'ADC_SARADC{unit}_'
        if chip not in ('esp32s3', 'esp32h2'):
            analog_init.append(analog_field(prefix_ref + 'ENCAL_REF_ADDR', 0))
        analog_init.append(analog_field(f'ADC_SAR{unit}_ENCAL_GND_ADDR', 0))
    for unit in ((1, 2) if chip in ('esp32p4', 'esp32s3') else (1,)):
        analog_init.append(analog_field(f'ADC_SAR{unit}_DREF_ADDR', 4 if chip in ('esp32p4', 'esp32s3') else 1))
        if f'ADC_SAR{unit}_SAMPLE_CYCLE_ADDR' in definitions:
            analog_init.append(analog_field(f'ADC_SAR{unit}_SAMPLE_CYCLE_ADDR', 2))
    # C3: ROM host 0, RTC_I2C control layout also documented in the S2 ROM patch.
    # C6/H2/P4: select a master using ANA_CONF2, as in their ROM patches.
    if chip == 'esp32c3':
        bus = {'control': n('DR_REG_RTC_I2C_BASE'), 'init': [write('RTC_CNTL_ANA_CONF_REG', ('RTC_CNTL_SAR_I2C_PU', 1)), {'address': n('SYSCON_WIFI_CLK_EN_REG'), 'value': n('SYSTEM_WIFI_CLK_I2C_CLK_EN'), 'mask': n('SYSTEM_WIFI_CLK_I2C_CLK_EN')}]}
    elif chip == 'esp32s3':
        # S3 ROM rom_get_i2c_hostid(0x69) selects master 0, ignoring the
        # legacy HOSTID macro. rom_chip_i2c_readReg_org uses command bit 26.
        bus = {'control': 0x6000e000, 'commandMask': 1 << 26, 'init': [
            write('RTC_CNTL_ANA_CONF_REG', ('RTC_CNTL_SAR_I2C_PU', 1)),
            # Like rom_chip_i2c_readReg_org: mask every other analog block.
            # After ROM download most blocks are unmasked and SAR accesses read 0.
            {'address': n('ANA_CONFIG_REG'), 'value': 0xffffffff & ~n('I2C_SAR_M'), 'mask': 0xffffffff},
            {'address': n('ANA_CONFIG2_REG'), 'value': 0x1ff40, 'mask': 0x1fff0}]}
    else:
        prefix = 'I2C_MST_' if chip == 'esp32h2' else 'I2C_ANA_MST_'
        modem_master = chip in ('esp32c6', 'esp32h2')
        bus = {'control': n(prefix + 'I2C0_CTRL_REG'), 'select': n(prefix + 'ANA_CONF2_REG'), 'selectBit': 1 << (11 if modem_master else 7), 'init': []}
        bus['init'].append({"address": n(prefix + 'ANA_CONF1_REG'), "value": n(prefix + 'ANA_CONF1_M') & ~(1 << 9) if modem_master else 0, "mask": n(prefix + 'ANA_CONF1_M')})
        if modem_master:
            bus['init'].insert(0, write('MODEM_LPCON_CLK_CONF_REG', ('MODEM_LPCON_CLK_I2C_MST_EN', 1)))
            if chip == 'esp32c6':
                # A RAM stub inherits ROM clock gating, not IDF's rtc_clk_init().
                active = write('MODEM_LPCON_CLK_CONF_POWER_ST_REG',
                    ('MODEM_LPCON_CLK_LP_APB_ST_MAP', 1 << 2),
                    ('MODEM_LPCON_CLK_I2C_MST_ST_MAP', 1 << 2))
                active['mask'] = active['value']
                bus['init'].insert(0, active)
        else:
            bus['init'].insert(0, write('LPPERI_CLK_EN_REG', ('LPPERI_CK_EN_LP_I2CMST', 1)))
            bus['init'].append({"address": bus['select'], "value": bus['selectBit'], "mask": n('I2C_ANA_MST_ANA_CONF2_M')})
    profile['analog'] = {'block': n('I2C_SAR_ADC'), 'bus': bus, 'init': analog_init}
    if chip == 'esp32c6':
        profile['init'].append(write('LPPERI_CLK_EN_REG', ('LPPERI_LP_IO_CK_EN', 1)))
        profile['padRoute'] = {
            'mux': n('LP_IO_GPIO0_REG'), 'select': n('LP_AON_GPIO_MUX_REG'),
            'muxMask': n('LP_IO_LP_GPIO0_MCU_SEL_M') | n('LP_IO_LP_GPIO0_SLP_SEL_M') | n('LP_IO_LP_GPIO0_FUN_IE_M') | n('LP_IO_LP_GPIO0_FUN_WPU_M') | n('LP_IO_LP_GPIO0_FUN_WPD_M'),
            'muxGPIO': n('LP_IO_LP_GPIO0_FUN_IE_M'),
            'pullUp': n('LP_IO_LP_GPIO0_FUN_WPU_M'), 'pullDown': n('LP_IO_LP_GPIO0_FUN_WPD_M'),
            'pinConfig': n('LP_IO_PIN0_REG'), 'pinConfigMask': n('LP_IO_LP_GPIO0_PAD_DRIVER_M'),
            'bank': {key: n(name) for key, name in {'input': 'LP_IO_IN_REG', 'output': 'LP_IO_OUT_DATA_REG', 'set': 'LP_IO_OUT_DATA_W1TS_REG', 'clear': 'LP_IO_OUT_DATA_W1TC_REG', 'enable': 'LP_IO_OUT_ENABLE_REG', 'enableSet': 'LP_IO_OUT_ENABLE_W1TS_REG', 'enableClear': 'LP_IO_OUT_ENABLE_W1TC_REG'}.items()}}
    profile['hardwareCalibration'] = {'major': efuse_field('BLK_VERSION_MAJOR'), 'minor': efuse_field('BLK_VERSION_MINOR') if chip not in ('esp32c3', 'esp32s3') else None, 'offset': {'esp32c3': 1000, 'esp32c6': 1600, 'esp32p4': 1400, 'esp32s3': 0, 'esp32h2': 1600}[chip], 'units': {}}
    if chip == 'esp32h2':
        profile['hardwareCalibration']['minVersion'] = 2
    for unit in ((1, 2) if chip in ('esp32p4', 'esp32s3') else (1,)):
        name = f'ADC{unit}_AVE_INITCODE_ATTEN3' if chip in ('esp32p4', 'esp32h2') else 'ADC1_INIT_CODE_ATTEN3'
        info = {'high': analog_field(f'ADC_SAR{unit}_INITIAL_CODE_HIGH_ADDR', 0), 'low': analog_field(f'ADC_SAR{unit}_INITIAL_CODE_LOW_ADDR', 0)}
        if chip == 'esp32s3':
            info.update({'efuses': [efuse_field(f'ADC{unit}_INIT_CODE_ATTEN{atten}') for atten in range(4)], 'offset': 2010 if unit == 1 else 2020})
        else:
            info['efuse'] = efuse_field(name)
        profile['hardwareCalibration']['units'][str(unit)] = info
    profile['sources'] = [profile['source']] + [f'https://github.com/espressif/esp-idf/blob/v5.5.1/components/{path}' for path in (f'efuse/{chip}/esp_efuse_table.c', f'efuse/{chip}/esp_efuse_rtc_calib.c', f'soc/{chip}/include/soc/regi2c_saradc.h', f'bootloader_support/src/bootloader_random_{chip}.c')]
    if chip == 'esp32s3':
        profile['sources'] += [f'https://github.com/espressif/esp-idf/blob/v5.5.1/components/hal/{chip}/include/hal/{name}' for name in ('sar_ctrl_ll.h', 'regi2c_ctrl_ll.h')]
        profile['sources'].append('https://github.com/espressif/esp-rom-elfs/releases/tag/20241011')
    if chip == 'esp32h2':
        profile['sources'] += [f'https://github.com/espressif/esp-idf/blob/v5.5.1/components/{path}' for path in ('esp_rom/patches/esp_rom_regi2c_esp32h2.c', 'hal/esp32h2/include/hal/regi2c_ctrl_ll.h', 'hal/adc_oneshot_hal.c')]
    profiles[chip] = profile
target = ROOT / "configs" / "adc.js"
content = "// Generated from Espressif ESP-IDF v5.5.1 (Apache-2.0); scripts/generate-adc-data.py.\n"
content += "(function(root){'use strict';const profiles=" + json.dumps(profiles, separators=(",", ":")) + ";\n"
content += "if(typeof module==='object'&&module.exports)module.exports=profiles;else(root.ESPIO ||= {}).adcProfiles=profiles;})(globalThis);\n"
target.write_text(content, encoding="utf-8")
print(f"Generated ADC recipes: {', '.join(profiles)}")
