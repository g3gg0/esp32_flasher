"""Generate P4 HP I2C0/1 recipes from ESP-IDF v5.5.1 headers/LL."""
from pathlib import Path
import hashlib
import json
import re
import runpy

ROOT = Path(__file__).resolve().parents[1]
h = runpy.run_path(str(Path(__file__).with_name('generate-chip-data.py')))
folder = ROOT / 'reference' / 'esp32p4'
d = {}
for path in folder.glob('*.h'):
    d.update(h['macros'](path.read_text(encoding='utf-8')))
d.update(h['macros']((ROOT / 'reference/i2c-p4/i2c_ll.h').read_text(encoding='utf-8')))
n = h['Integers'](d).name
offsets = {name: int(offset, 16) for name, offset in re.findall(r'#define (I2C_\w+_REG)\(i\) \(REG_I2C_BASE\(i\) \+ (0x[0-9a-f]+)\)', (folder / 'i2c_reg.h').read_text())}
profiles = []
for port in (0, 1):
    base = n(f'DR_REG_I2C{port}_BASE')
    def reg(name): return base + offsets['I2C_' + name + '_REG']
    def write(address, *fields):
        mask = value = 0
        for name, data in fields:
            mask |= n(name + '_M')
            value |= data << n(name + '_S') & n(name + '_M')
        return {'address': address, 'value': value, 'mask': mask}
    timings = {}
    for speed in (100000, 400000):
        div = 40000000 // (speed * 1024) + 1
        half = (40000000 // div) // speed // 2
        wait_high = half // 2 - 2
        prefix = f'HP_SYS_CLKRST_REG_I2C{port}_'
        timings[str(speed)] = [
            # Both source/gate pairs live in CTRL10. I2C1's divider lives
            # in CTRL11; field names do not imply their register address.
            write(n('HP_SYS_CLKRST_PERI_CLK_CTRL10_REG'),
                  (prefix + 'CLK_EN', 1), (prefix + 'CLK_SRC_SEL', 0)),
            write(n(f'HP_SYS_CLKRST_PERI_CLK_CTRL{10 + port}_REG'),
                  (prefix + 'CLK_DIV_NUM', div - 1), (prefix + 'CLK_DIV_NUMERATOR', 0), (prefix + 'CLK_DIV_DENOMINATOR', 0)),
            write(reg('SCL_LOW_PERIOD'), ('I2C_SCL_LOW_PERIOD', half - 1)),
            write(reg('SCL_HIGH_PERIOD'), ('I2C_SCL_HIGH_PERIOD', half - wait_high), ('I2C_SCL_WAIT_HIGH_PERIOD', wait_high)),
            write(reg('SDA_HOLD'), ('I2C_SDA_HOLD_TIME', half // 4 - 1)),
            write(reg('SDA_SAMPLE'), ('I2C_SDA_SAMPLE_TIME', half // 2 - 1)),
            *[write(reg(register), (field, half - 1)) for register, field in (
                ('SCL_START_HOLD', 'I2C_SCL_START_HOLD_TIME'), ('SCL_RSTART_SETUP', 'I2C_SCL_RSTART_SETUP_TIME'),
                ('SCL_STOP_HOLD', 'I2C_SCL_STOP_HOLD_TIME'), ('SCL_STOP_SETUP', 'I2C_SCL_STOP_SETUP_TIME'))],
            write(reg('TO'), ('I2C_TIME_OUT_VALUE', (40000000 // div * 20000 // 1000000).bit_length()), ('I2C_TIME_OUT_EN', 1)),
        ]
    profiles.append({
        'port': port, 'fifoSize': 32, 'sourceClockHz': 40000000,
        'registers': {key: reg(name) for key, name in {'control': 'CTR', 'status': 'SR', 'fifoConfig': 'FIFO_CONF', 'data': 'DATA', 'events': 'INT_RAW', 'clear': 'INT_CLR', 'interruptEnable': 'INT_ENA', 'command': 'COMD0'}.items()},
        'flags': {key: n('I2C_' + name + '_M') for key, name in {'start': 'TRANS_START', 'update': 'CONF_UPGATE', 'reset': 'FSM_RST', 'fifoReset': 'RX_FIFO_RST', 'txReset': 'TX_FIFO_RST', 'busBusy': 'BUS_BUSY', 'commandDone': 'COMMAND0_DONE'}.items()},
        'rxCount': {'mask': n('I2C_RXFIFO_CNT_M'), 'shift': n('I2C_RXFIFO_CNT_S')},
        'opcodes': {key: n('I2C_LL_CMD_' + key.upper()) for key in ('restart', 'write', 'read', 'stop', 'end')},
        'init': [write(n('HP_SYS_CLKRST_SOC_CLK_CTRL2_REG'), (f'HP_SYS_CLKRST_REG_I2C{port}_APB_CLK_EN', 1)),
                 write(n('HP_SYS_CLKRST_HP_RST_EN1_REG'), (f'HP_SYS_CLKRST_REG_RST_EN_I2C{port}', 0))],
        'reset': write(n('HP_SYS_CLKRST_HP_RST_EN1_REG'), (f'HP_SYS_CLKRST_REG_RST_EN_I2C{port}', 1)),
        'master': write(reg('CTR'), ('I2C_MS_MODE', 1), ('I2C_SDA_FORCE_OUT', 0), ('I2C_SCL_FORCE_OUT', 0), ('I2C_TX_LSB_FIRST', 0), ('I2C_RX_LSB_FIRST', 0), ('I2C_ARBITRATION_EN', 0), ('I2C_RX_FULL_ACK_LEVEL', 0), ('I2C_CLK_EN', 0)),
        'fifo': write(reg('FIFO_CONF'), ('I2C_NONFIFO_EN', 0), ('I2C_FIFO_PRT_EN', 1)),
        'filter': write(reg('FILTER_CFG'), ('I2C_SCL_FILTER_THRES', 7), ('I2C_SDA_FILTER_THRES', 7), ('I2C_SCL_FILTER_EN', 1), ('I2C_SDA_FILTER_EN', 1)),
        'timings': timings,
        'matrix': {'inputBase': n('GPIO_FUNC1_IN_SEL_CFG_REG') - 4, 'inputMask': 255, 'inputEnable': n('GPIO_SIG1_IN_SEL_M'),
                   'openDrain': n('GPIO_PIN0_PAD_DRIVER_M'), 'signals': {role: n(f'I2C{port}_{role.upper()}_PAD_OUT_IDX') for role in ('sda', 'scl')}},
    })
data = {'esp32p4': {'ports': profiles, 'sources': [f'https://github.com/espressif/esp-idf/blob/v5.5.1/components/{p}' for p in (
    'hal/esp32p4/include/hal/i2c_ll.h', 'hal/i2c_hal.c', 'esp_driver_i2c/i2c_master.c', 'soc/esp32p4/register/soc/i2c_reg.h')],
    'sourceSha256': hashlib.sha256((folder / 'i2c_reg.h').read_bytes()).hexdigest()}}
content = '// Generated from ESP-IDF v5.5.1 (Apache-2.0); scripts/generate-i2c-data.py.\n'
content += "(function(root){'use strict';const profiles=" + json.dumps(data, separators=(',', ':')) + ';\n'
content += "if(typeof module==='object'&&module.exports)module.exports=profiles;else(root.ESPIO ||= {}).i2cProfiles=profiles;})(globalThis);\n"
(ROOT / 'configs/i2c.js').write_text(content, encoding='utf-8')
print('Generated P4 I2C0/1, XTAL 40 MHz, 100/400 kHz')
