"""Generate P4/S3 SDMMC slot-1 register recipes from pinned ESP-IDF headers."""
from pathlib import Path
import hashlib
import json
import runpy

ROOT = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(Path(__file__).with_name('generate-chip-data.py')))
folder = ROOT / 'reference' / 'esp32p4'
definitions = {}
for file in sorted(folder.glob('*.h')):
    definitions.update(helpers['macros'](file.read_text(encoding='utf-8')))
n = helpers['Integers'](definitions).name

def write(register, *fields):
    mask = value = 0
    for name, data in fields:
        mask |= n(name + '_M')
        value |= data << n(name + '_S') & n(name + '_M')
    return {'address': n(register), 'value': value, 'mask': mask}

phase = 'HP_SYS_CLKRST_REG_SDIO_LS_'
p = {
    'backend': 'sdmmc', 'slot': 1, 'clockHz': 400000,
    'cardDivider': 100,
    'registers': {key: n('SDHOST_' + name + '_REG') for key, name in {
        'control': 'CTRL', 'clockDivider': 'CLKDIV', 'clockSource': 'CLKSRC',
        'clockEnable': 'CLKENA', 'timeout': 'TMOUT', 'width': 'CTYPE',
        'interruptMask': 'INTMASK', 'argument': 'CMDARG', 'command': 'CMD',
        'response': 'RESP0', 'events': 'RINTSTS', 'status': 'STATUS', 'dma': 'BMOD',
        'blockSize': 'BLKSIZ', 'byteCount': 'BYTCNT', 'fifoThreshold': 'FIFOTH',
        'transferred': 'TBBCNT', 'pollDemand': 'PLDMND', 'descriptorList': 'DBADDR', 'dmaStatus': 'IDSTS',
    }.items()},
    'flags': {key: n('SDHOST_' + name + '_M') for key, name in {
        'start': 'START_CMD', 'response': 'RESPONSE_EXPECT', 'longResponse': 'RESPONSE_LENGTH',
        'crc': 'CHECK_RESPONSE_CRC', 'waitData': 'WAIT_PRVDATA_COMPLETE',
        'initialClocks': 'SEND_INITIALIZATION', 'clockUpdate': 'UPDATE_CLOCK_REGISTERS_ONLY',
        'hold': 'USE_HOLE_REG',
        'dataExpected': 'DATA_EXPECTED',
    }.items()},
    'init': [
        write('HP_SYS_CLKRST_SOC_CLK_CTRL1_REG', ('HP_SYS_CLKRST_REG_SDMMC_SYS_CLK_EN', 1)),
        write('HP_SYS_CLKRST_REF_CLK_CTRL2_REG', ('HP_SYS_CLKRST_REG_REF_160M_CLK_EN', 1)),
        write('LP_CLKRST_HP_SDMMC_EMAC_RST_CTRL_REG', ('LP_CLKRST_RST_EN_SDMMC', 0)),
        write('HP_SYS_CLKRST_PERI_CLK_CTRL01_REG', ('HP_SYS_CLKRST_REG_SDIO_HS_MODE', 0),
              (phase + 'CLK_SRC_SEL', 0), (phase + 'CLK_EN', 1)),
        write('HP_SYS_CLKRST_PERI_CLK_CTRL02_REG',
              (phase + 'CLK_EDGE_H', 0), (phase + 'CLK_EDGE_N', 1), (phase + 'CLK_EDGE_L', 1),
              (phase + 'DRV_CLK_EN', 1), (phase + 'SAM_CLK_EN', 1), (phase + 'SLF_CLK_EN', 1),
              (phase + 'DRV_CLK_EDGE_SEL', 1), (phase + 'SAM_CLK_EDGE_SEL', 0),
              (phase + 'SLF_CLK_EDGE_SEL', 0), (phase + 'CLK_EDGE_CFG_UPDATE', 0)),
    ],
    'latchClock': write('HP_SYS_CLKRST_PERI_CLK_CTRL02_REG', (phase + 'CLK_EDGE_CFG_UPDATE', 1)),
    'reset': write('LP_CLKRST_HP_SDMMC_EMAC_RST_CTRL_REG', ('LP_CLKRST_RST_EN_SDMMC', 1)),
    'fifo': {'countMask': n('SDHOST_FIFO_COUNT_M'), 'countShift': n('SDHOST_FIFO_COUNT_S')},
    # CPU reads do not drain the P4 FIFO (verified on hardware), so sectors are
    # received by the internal DMA like in ESP-IDF. Descriptor + 512 bytes sit
    # above the flasher stub (0x4ff50000-0x4ff72e84); ROM data/stacks stay below
    # 0x4ff40000. CPU accesses use the non-cacheable alias
    # (SOC_NON_CACHEABLE_OFFSET), bypassing the write-back L1 cache.
    'dmaBuffer': {'address': 0x4ff78000, 'cpuOffset': 0x40000000},
    'matrix': {
        'inputBase': n('GPIO_FUNC1_IN_SEL_CFG_REG') - 4, 'inputMask': 255,
        'inputEnable': n('GPIO_SIG1_IN_SEL_M'),
        'signals': {role: n('SD_CARD_' + name + '_2_PAD_OUT_IDX') for role, name in {
            'clk': 'CCLK', 'cmd': 'CCMD', 'd0': 'CDATA0', 'd1': 'CDATA1', 'd2': 'CDATA2', 'd3': 'CDATA3',
        }.items()},
        'detect': n('SD_CARD_DETECT_N_2_PAD_IN_IDX'),
        'writeProtect': n('SD_CARD_WRITE_PRT_2_PAD_IN_IDX'),
        'cardInterrupt': n('SD_CARD_INT_N_2_PAD_IN_IDX'),
        'constantHigh': n('GPIO_MATRIX_CONST_ONE_INPUT'), 'constantLow': n('GPIO_MATRIX_CONST_ZERO_INPUT'),
    },
    'sources': [f'https://github.com/espressif/esp-idf/blob/v5.5.1/components/{path}' for path in (
        'hal/esp32p4/include/hal/sdmmc_ll.h', 'esp_driver_sdmmc/src/sdmmc_host.c',
        'esp_driver_sdmmc/src/sdmmc_transaction.c', 'soc/esp32p4/register/soc/sdmmc_reg.h',
        'sdmmc/include/sd_protocol_defs.h', 'sdmmc/sdmmc_sd.c',
        'hal/esp32p4/include/hal/clk_gate_ll.h')],
    'sourceSha256': {name: hashlib.sha256((folder / name).read_bytes()).hexdigest()
                     for name in ('sdmmc_reg.h', 'hp_sys_clkrst_reg.h', 'lp_clkrst_reg.h', 'gpio_sig_map.h')},
}
profiles = {'esp32p4': p}
folder = ROOT / 'reference' / 'esp32s3'
definitions = {}
for file in sorted(folder.glob('*.h')):
    definitions.update(helpers['macros'](file.read_text(encoding='utf-8')))
n = helpers['Integers'](definitions).name

# The S3 register header names addresses only; field positions are defined by
# sdmmc_struct.h and TRM chapter 34 (SDHOST). CLOCK is outside the core at +0x800.
s3 = {
    'backend': 'sdmmc', 'slot': 1, 'clockHz': 400000, 'cardDivider': 20,
    'registers': {
        key: n('SDMMC_' + name + '_REG') for key, name in {
            'control': 'CTRL', 'clockDivider': 'CLKDIV', 'clockSource': 'CLKSRC',
            'clockEnable': 'CLKENA', 'timeout': 'TMOUT', 'width': 'CTYPE',
            'interruptMask': 'INTMASK', 'argument': 'CMDARG', 'command': 'CMD',
            'response': 'RESP0', 'events': 'RINTSTS', 'status': 'STATUS', 'dma': 'BMOD',
            'blockSize': 'BLKSIZ', 'byteCount': 'BYTCNT', 'fifoThreshold': 'FIFOTH',
            'transferred': 'TBBCNT', 'pollDemand': 'PLDMND', 'descriptorList': 'DBADDR', 'dmaStatus': 'IDSTS',
        }.items()
    },
    'flags': dict(p['flags']),
    'init': [
        write('SYSTEM_PERIP_CLK_EN1_REG', ('SYSTEM_SDIO_HOST_CLK_EN', 1)),
        write('SYSTEM_PERIP_RST_EN1_REG', ('SYSTEM_SDIO_HOST_RST', 0)),
    ],
    # PLL160M / 10, dout phase 90 degrees; card divider 20 gives 400 kHz.
    'hostClock': {'address': n('SDMMC_CLOCK_REG'),
                  'value': 1 | 4 << 9 | 9 << 13 | 9 << 17 | 1 << 23,
                  'mask': 0x1fffff | 1 << 23},
    'reset': write('SYSTEM_PERIP_RST_EN1_REG', ('SYSTEM_SDIO_HOST_RST', 1)),
    'fifo': {'countMask': 0x1fff << 17, 'countShift': 17},
    # Same DMA path as P4; S3 internal SRAM is uncached. Above the stub
    # (0x3fc88000-0x3fc89674, 0x3fca0000-0x3fcb2df8) and below the ROM
    # download buffers from 0x3fcd7e00 (ESP-IDF bootloader.ld).
    'dmaBuffer': {'address': 0x3fcc0000, 'cpuOffset': 0},
    'matrix': {
        'inputBase': n('GPIO_FUNC0_IN_SEL_CFG_REG'), 'inputMask': 0xff, 'inputEnable': 1 << 7,
        'signals': {role: n(name) for role, name in {
            'clk': 'SDHOST_CCLK_OUT_2_IDX', 'cmd': 'SDHOST_CCMD_OUT_2_IDX',
            'd0': 'SDHOST_CDATA_OUT_20_IDX', 'd1': 'SDHOST_CDATA_OUT_21_IDX',
            'd2': 'SDHOST_CDATA_OUT_22_IDX', 'd3': 'SDHOST_CDATA_OUT_23_IDX',
        }.items()},
        'detect': n('SDHOST_CARD_DETECT_N_2_IDX'),
        'writeProtect': n('SDHOST_CARD_WRITE_PRT_2_IDX'),
        'cardInterrupt': n('SDHOST_CARD_INT_N_2_IDX'),
        'constantHigh': 0x38, 'constantLow': 0x3c,
    },
    'sources': [f'https://github.com/espressif/esp-idf/blob/v5.5.1/components/{path}' for path in (
        'hal/esp32s3/include/hal/sdmmc_ll.h', 'soc/esp32s3/sdmmc_periph.c',
        'soc/esp32s3/register/soc/sdmmc_struct.h', 'soc/esp32s3/register/soc/sdmmc_reg.h',
        'soc/esp32s3/register/soc/system_reg.h', 'soc/esp32s3/include/soc/gpio_sig_map.h',
        'esp_driver_sdmmc/src/sdmmc_host.c')],
    'sourceSha256': {name: hashlib.sha256((folder / name).read_bytes()).hexdigest()
                     for name in ('sdmmc_reg.h', 'system_reg.h', 'gpio_sig_map.h')},
}
s3['sourceSha256'].update({name: hashlib.sha256((ROOT / 'reference' / 'sd-s3' / name).read_bytes()).hexdigest()
                          for name in ('sdmmc_ll.h', 'sdmmc_struct.h', 'sdmmc_periph.c')})
profiles['esp32s3'] = s3
content = '// Generated from ESP-IDF v5.5.1 (Apache-2.0); scripts/generate-sd-data.py.\n'
content += "(function(root){'use strict';const profiles=" + json.dumps(profiles, separators=(',', ':')) + ';\n'
content += "if(typeof module==='object'&&module.exports)module.exports=profiles;else(root.ESPIO ||= {}).sdProfiles=profiles;})(globalThis);\n"
(ROOT / 'configs' / 'sd.js').write_bytes(content.encode('utf-8'))
print('Generated SDMMC recipe: ESP32-P4 slot 1, PLL160M / 2 / (2 * 100) = 400 kHz')
print('Generated SDMMC recipe: ESP32-S3 slot 1, PLL160M / 10 / (2 * 20) = 400 kHz')
