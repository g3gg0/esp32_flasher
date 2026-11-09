// I²C Analyzer: bus scan, device identification and a named register map.
// Uses the I²C port that was activated in the I²C block of the lab.
(function () {
    const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');
    const bits = (value, ...fields) => fields.map(([hi, lo, name, names]) => {
        const v = (value >> lo) & ((1 << (hi - lo + 1)) - 1);
        return `${name}=${names?.[v] ?? v}`;
    }).join(' ');
    const bcd = v => (v >> 4) * 10 + (v & 15);
    const LSM6_IDS = { 0x69: 'LSM6DS3', 0x6A: 'LSM6DSL / LSM6DS3TR-C', 0x6B: 'LSM6DSR', 0x6C: 'LSM6DSO / LSM6DSOX', 0x70: 'LSM6DSV' };
    const LSM6_ODR = ['aus', '12.5Hz', '26Hz', '52Hz', '104Hz', '208Hz', '416Hz', '833Hz', '1.66kHz', '3.33kHz', '6.66kHz'];
    const LSM6_ACCEL_MG = [0.061, 0.488, 0.122, 0.244];
    const LSM6_GYRO_MDPS = [8.75, 17.5, 35, 70, 4.375];
    const lsm6GyroFs = all => { const ctrl2 = all.get(0x11) ?? 0; return ctrl2 & 2 ? 4 : ctrl2 >> 2 & 3; };
    // Combines the little-endian L/H pair; the H register shows the scaled value.
    const lsm6Word = (all, low, format) => { const lo = all.get(low), hi = all.get(low + 1); return lo == null || hi == null ? '' : format(((hi << 8 | lo) << 16) >> 16); };
    // REG14: PN[5:3]=111 (BQ25895), DEV_REV[1:0]=01.
    const isBq2589x = r14 => (r14 & 0x3B) === 0x39;
    const QMI_ACCEL_FS = [2, 4, 8, 16];
    const QMI_GYRO_FS = [16, 32, 64, 128, 256, 512, 1024, 2048];
    const QMI_ACCEL_ODR = ['7174Hz (6DOF)', '3587Hz (6DOF)', '1794Hz (6DOF)', '1000Hz / 6DOF 896.8Hz', '500Hz / 6DOF 448.4Hz', '250Hz / 6DOF 224.2Hz', '125Hz / 6DOF 112.1Hz', '62.5Hz / 6DOF 56.05Hz', '31.25Hz / 6DOF 28.03Hz', 'n/a', 'n/a', 'n/a', 'LP 128Hz', 'LP 21Hz', 'LP 11Hz', 'LP 3Hz'];
    const QMI_GYRO_ODR = ['7174.4Hz', '3587.2Hz', '1793.6Hz', '896.8Hz', '448.4Hz', '224.2Hz', '112.1Hz', '56.05Hz', '28.025Hz', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a'];
    const QMI_LPF = ['2.66% ODR', '3.63% ODR', '5.39% ODR', '13.37% ODR'];

    // width 1: byte registers, burst reads; width 2: 16-bit big-endian pointer registers.
    const DEVICES = [
        {
            name: 'BME280 / BMP280', addresses: [0x76, 0x77], id: { reg: 0xD0, values: { 0x60: 'BME280', 0x58: 'BMP280', 0x56: 'BMP280 (Muster)', 0x57: 'BMP280 (Muster)', 0x61: 'BME680' } }, range: [0x88, 0xFF],
            regs: { 0xD0: 'id', 0xE0: 'reset', 0xF2: 'ctrl_hum', 0xF3: 'status', 0xF4: 'ctrl_meas', 0xF5: 'config', 0xF7: 'press_msb', 0xF8: 'press_lsb', 0xF9: 'press_xlsb', 0xFA: 'temp_msb', 0xFB: 'temp_lsb', 0xFC: 'temp_xlsb', 0xFD: 'hum_msb', 0xFE: 'hum_lsb', 0xE1: 'calib26 (H2 lsb)' },
            decode: { 0xF2: v => bits(v, [2, 0, 'osrs_h']), 0xF3: v => bits(v, [3, 3, 'measuring'], [0, 0, 'im_update']), 0xF4: v => bits(v, [7, 5, 'osrs_t'], [4, 2, 'osrs_p'], [1, 0, 'mode', { 0: 'sleep', 1: 'forced', 2: 'forced', 3: 'normal' }]), 0xF5: v => bits(v, [7, 5, 't_sb'], [4, 2, 'filter'], [0, 0, 'spi3w_en']) }
        },
        {
            name: 'MPU-6050 / 6500 / 9250', addresses: [0x68, 0x69], id: { reg: 0x75, values: { 0x68: 'MPU-6050', 0x70: 'MPU-6500', 0x71: 'MPU-9250', 0x73: 'MPU-9255', 0x72: 'MPU-6050 (Klon)' } }, range: [0x00, 0x7F],
            regs: { 0x19: 'SMPLRT_DIV', 0x1A: 'CONFIG', 0x1B: 'GYRO_CONFIG', 0x1C: 'ACCEL_CONFIG', 0x23: 'FIFO_EN', 0x37: 'INT_PIN_CFG', 0x38: 'INT_ENABLE', 0x3A: 'INT_STATUS', 0x3B: 'ACCEL_XOUT_H', 0x3C: 'ACCEL_XOUT_L', 0x3D: 'ACCEL_YOUT_H', 0x3E: 'ACCEL_YOUT_L', 0x3F: 'ACCEL_ZOUT_H', 0x40: 'ACCEL_ZOUT_L', 0x41: 'TEMP_OUT_H', 0x42: 'TEMP_OUT_L', 0x43: 'GYRO_XOUT_H', 0x44: 'GYRO_XOUT_L', 0x45: 'GYRO_YOUT_H', 0x46: 'GYRO_YOUT_L', 0x47: 'GYRO_ZOUT_H', 0x48: 'GYRO_ZOUT_L', 0x6A: 'USER_CTRL', 0x6B: 'PWR_MGMT_1', 0x6C: 'PWR_MGMT_2', 0x75: 'WHO_AM_I' },
            decode: { 0x1B: v => bits(v, [4, 3, 'FS_SEL', ['±250°/s', '±500°/s', '±1000°/s', '±2000°/s']]), 0x1C: v => bits(v, [4, 3, 'AFS_SEL', ['±2g', '±4g', '±8g', '±16g']]), 0x6B: v => bits(v, [7, 7, 'DEVICE_RESET'], [6, 6, 'SLEEP'], [3, 3, 'TEMP_DIS'], [2, 0, 'CLKSEL']) }
        },
        {
            name: 'DS3231 RTC', addresses: [0x68], range: [0x00, 0x12],
            id: { probe: async read => { const [s, m, h, , d, mo] = await read(0, 6); return (s & 0x80) === 0 && bcd(s) < 60 && bcd(m & 0x7F) < 60 && (h & 0x80) === 0 && bcd(d) >= 1 && bcd(d) <= 31 && (mo & 0x1F) >= 1 ? 'DS3231 / DS1307 (Zeitregister plausibel)' : ''; } },
            regs: { 0x00: 'Seconds', 0x01: 'Minutes', 0x02: 'Hours', 0x03: 'Day', 0x04: 'Date', 0x05: 'Month/Century', 0x06: 'Year', 0x07: 'Alarm1 Sec', 0x08: 'Alarm1 Min', 0x09: 'Alarm1 Hour', 0x0A: 'Alarm1 Day/Date', 0x0B: 'Alarm2 Min', 0x0C: 'Alarm2 Hour', 0x0D: 'Alarm2 Day/Date', 0x0E: 'Control', 0x0F: 'Control/Status', 0x10: 'Aging offset', 0x11: 'Temp MSB', 0x12: 'Temp LSB' },
            decode: { 0x00: v => `${bcd(v & 0x7F)} s`, 0x01: v => `${bcd(v & 0x7F)} min`, 0x02: v => `${bcd(v & 0x3F)} h`, 0x06: v => `20${String(bcd(v)).padStart(2, '0')}`, 0x0E: v => bits(v, [7, 7, '/EOSC'], [2, 2, 'INTCN']), 0x0F: v => bits(v, [7, 7, 'OSF'], [2, 2, 'BSY'], [1, 1, 'A2F'], [0, 0, 'A1F']), 0x11: v => `${v > 127 ? v - 256 : v} °C` }
        },
        {
            name: 'INA219', addresses: Array.from({ length: 16 }, (_, i) => 0x40 + i), width: 2, range: [0x00, 0x05],
            id: { probe: async read => { const [hi, lo] = await read(0, 2); return (hi << 8 | lo) === 0x399F ? 'INA219 (Config-Reset 0x399F)' : ''; } },
            regs: { 0x00: 'Configuration', 0x01: 'Shunt voltage', 0x02: 'Bus voltage', 0x03: 'Power', 0x04: 'Current', 0x05: 'Calibration' },
            decode: { 0x01: v => `${((v << 16) >> 16) * 10} µV`, 0x02: v => `${(v >> 3) * 4} mV` }
        },
        {
            name: 'INA226', addresses: Array.from({ length: 16 }, (_, i) => 0x40 + i), width: 2, range: [0x00, 0x08], extra: [0xFE, 0xFF],
            id: { probe: async read => { const [hi, lo] = await read(0xFE, 2); return (hi << 8 | lo) === 0x5449 ? 'INA226 / INA23x (TI)' : ''; } },
            regs: { 0x00: 'Configuration', 0x01: 'Shunt voltage', 0x02: 'Bus voltage', 0x03: 'Power', 0x04: 'Current', 0x05: 'Calibration', 0x06: 'Mask/Enable', 0x07: 'Alert limit', 0xFE: 'Manufacturer ID', 0xFF: 'Die ID' },
            decode: { 0x01: v => `${((v << 16) >> 16) * 2.5} µV`, 0x02: v => `${v * 1.25} mV` }
        },
        {
            name: 'TMP117', addresses: [0x48, 0x49, 0x4A, 0x4B], width: 2, range: [0x00, 0x08], extra: [0x0F],
            id: { probe: async read => { const [hi, lo] = await read(0x0F, 2); return (hi << 8 | lo) === 0x0117 ? 'TMP117' : ''; } },
            regs: { 0x00: 'Temp_Result', 0x01: 'Configuration', 0x02: 'THigh_Limit', 0x03: 'TLow_Limit', 0x04: 'EEPROM_UL', 0x05: 'EEPROM1', 0x06: 'EEPROM2', 0x07: 'Temp_Offset', 0x08: 'EEPROM3', 0x0F: 'Device_ID' },
            decode: { 0x00: v => `${(((v << 16) >> 16) * 0.0078125).toFixed(3)} °C` }
        },
        {
            name: 'ADS1115 / ADS1015', addresses: [0x48, 0x49, 0x4A, 0x4B], width: 2, range: [0x00, 0x03],
            id: { probe: async read => { const [hi, lo] = await read(1, 2); return (hi << 8 | lo) === 0x8583 ? 'ADS1115 / ADS1015 (Config-Reset 0x8583)' : ''; } },
            regs: { 0x00: 'Conversion', 0x01: 'Config', 0x02: 'Lo_thresh', 0x03: 'Hi_thresh' }
        },
        {
            name: 'VL53L0X', addresses: [0x29], id: { reg: 0xC0, values: { 0xEE: 'VL53L0X' } }, range: [0xC0, 0xC2],
            regs: { 0xC0: 'IDENTIFICATION_MODEL_ID', 0xC1: 'IDENTIFICATION_REVISION_ID', 0xC2: 'MODULE_TYPE' }
        },
        {
            name: 'TCS34725', addresses: [0x29], id: { reg: 0x92, values: { 0x44: 'TCS34725', 0x4D: 'TCS34727' } }, range: [0x80, 0x9F],
            regs: { 0x80: 'ENABLE', 0x81: 'ATIME', 0x83: 'WTIME', 0x8D: 'CONFIG', 0x8F: 'CONTROL', 0x92: 'ID', 0x93: 'STATUS', 0x94: 'CDATAL', 0x95: 'CDATAH', 0x96: 'RDATAL', 0x97: 'RDATAH', 0x98: 'GDATAL', 0x99: 'GDATAH', 0x9A: 'BDATAL', 0x9B: 'BDATAH' }
        },
        {
            name: 'LSM6DS3 / LSM6DSx IMU', addresses: [0x6A, 0x6B], range: [0x00, 0x6B],
            // BQ25895 shares 0x6A: its REG0F (SYSV) can read like a WHO_AM_I, so reject a BQ2589x part ID in REG14.
            id: { probe: async read => { const [who] = await read(0x0F, 1), [r14] = await read(0x14, 1), [r00] = await read(0x00, 1); const name = LSM6_IDS[who]; return name && !isBq2589x(r14) && r00 !== 0x05 ? `${name} (WHO_AM_I 0x${hex2(who)})` : ''; } },
            regs: {
                0x01: 'FUNC_CFG_ACCESS', 0x04: 'SENSOR_SYNC_TIME_FRAME', 0x06: 'FIFO_CTRL1', 0x07: 'FIFO_CTRL2', 0x08: 'FIFO_CTRL3', 0x09: 'FIFO_CTRL4', 0x0A: 'FIFO_CTRL5', 0x0B: 'ORIENT_CFG_G',
                0x0D: 'INT1_CTRL', 0x0E: 'INT2_CTRL', 0x0F: 'WHO_AM_I', 0x10: 'CTRL1_XL', 0x11: 'CTRL2_G', 0x12: 'CTRL3_C', 0x13: 'CTRL4_C', 0x14: 'CTRL5_C', 0x15: 'CTRL6_C', 0x16: 'CTRL7_G',
                0x17: 'CTRL8_XL', 0x18: 'CTRL9_XL', 0x19: 'CTRL10_C', 0x1A: 'MASTER_CONFIG', 0x1B: 'WAKE_UP_SRC', 0x1C: 'TAP_SRC', 0x1D: 'D6D_SRC', 0x1E: 'STATUS_REG',
                0x20: 'OUT_TEMP_L', 0x21: 'OUT_TEMP_H', 0x22: 'OUTX_L_G', 0x23: 'OUTX_H_G', 0x24: 'OUTY_L_G', 0x25: 'OUTY_H_G', 0x26: 'OUTZ_L_G', 0x27: 'OUTZ_H_G',
                0x28: 'OUTX_L_XL', 0x29: 'OUTX_H_XL', 0x2A: 'OUTY_L_XL', 0x2B: 'OUTY_H_XL', 0x2C: 'OUTZ_L_XL', 0x2D: 'OUTZ_H_XL',
                ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [0x2E + i, `SENSORHUB${i + 1}_REG`])),
                0x3A: 'FIFO_STATUS1', 0x3B: 'FIFO_STATUS2', 0x3C: 'FIFO_STATUS3', 0x3D: 'FIFO_STATUS4', 0x3E: 'FIFO_DATA_OUT_L', 0x3F: 'FIFO_DATA_OUT_H',
                0x40: 'TIMESTAMP0_REG', 0x41: 'TIMESTAMP1_REG', 0x42: 'TIMESTAMP2_REG', 0x49: 'STEP_TIMESTAMP_L', 0x4A: 'STEP_TIMESTAMP_H', 0x4B: 'STEP_COUNTER_L', 0x4C: 'STEP_COUNTER_H',
                ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [0x4D + i, `SENSORHUB${i + 13}_REG`])),
                0x53: 'FUNC_SRC', 0x58: 'TAP_CFG', 0x59: 'TAP_THS_6D', 0x5A: 'INT_DUR2', 0x5B: 'WAKE_UP_THS', 0x5C: 'WAKE_UP_DUR', 0x5D: 'FREE_FALL', 0x5E: 'MD1_CFG', 0x5F: 'MD2_CFG',
                0x66: 'OUT_MAG_RAW_X_L', 0x67: 'OUT_MAG_RAW_X_H', 0x68: 'OUT_MAG_RAW_Y_L', 0x69: 'OUT_MAG_RAW_Y_H', 0x6A: 'OUT_MAG_RAW_Z_L', 0x6B: 'OUT_MAG_RAW_Z_H'
            },
            decode: {
                0x0F: v => LSM6_IDS[v] || 'unbekannte ID',
                0x10: v => bits(v, [7, 4, 'ODR_XL', LSM6_ODR], [3, 2, 'FS_XL', ['±2g', '±16g', '±4g', '±8g']], [1, 0, 'BW_XL', ['400Hz', '200Hz', '100Hz', '50Hz']]),
                0x11: v => bits(v, [7, 4, 'ODR_G', LSM6_ODR], [3, 2, 'FS_G', ['245dps', '500dps', '1000dps', '2000dps']], [1, 1, 'FS_125']),
                0x12: v => bits(v, [7, 7, 'BOOT'], [6, 6, 'BDU'], [5, 5, 'H_LACTIVE'], [4, 4, 'PP_OD'], [3, 3, 'SIM'], [2, 2, 'IF_INC'], [1, 1, 'BLE'], [0, 0, 'SW_RESET']),
                0x1E: v => bits(v, [3, 3, 'EV_BOOT'], [2, 2, 'TDA'], [1, 1, 'GDA'], [0, 0, 'XLDA']),
                0x21: (v, all) => lsm6Word(all, 0x20, raw => `${(25 + raw / (all.get(0x0F) === 0x69 ? 16 : 256)).toFixed(2)} °C`),
                ...Object.fromEntries([0x23, 0x25, 0x27].map((reg, i) => [reg, (v, all) => lsm6Word(all, reg - 1, raw => `${'XYZ'[i]} ${(raw * LSM6_GYRO_MDPS[lsm6GyroFs(all)] / 1000).toFixed(2)} °/s`)])),
                ...Object.fromEntries([0x29, 0x2B, 0x2D].map((reg, i) => [reg, (v, all) => lsm6Word(all, reg - 1, raw => `${'XYZ'[i]} ${(raw * LSM6_ACCEL_MG[(all.get(0x10) ?? 0) >> 2 & 3] / 1000).toFixed(3)} g`)])),
                0x4C: (v, all) => all.get(0x4B) == null ? '' : `${v << 8 | all.get(0x4B)} Schritte`
            }
        },
        {
            name: 'BQ25895 Lader', addresses: [0x6A, 0x6B], range: [0x00, 0x14],
            id: { probe: async read => { const [r14] = await read(0x14, 1); return isBq2589x(r14) ? `BQ25895 (REG14 0x${hex2(r14)}, Rev ${r14 & 3})` : ''; } },
            regs: { 0x00: 'REG00 Input source', 0x01: 'REG01 NTC / VINDPM offset', 0x02: 'REG02 ADC / DPDM', 0x03: 'REG03 Charge config', 0x04: 'REG04 Fast charge current', 0x05: 'REG05 Pre-charge / term current',
                0x06: 'REG06 Charge voltage', 0x07: 'REG07 Term / timer / watchdog', 0x08: 'REG08 IR comp / thermal', 0x09: 'REG09 Operation control', 0x0A: 'REG0A Boost', 0x0B: 'REG0B Status',
                0x0C: 'REG0C Faults', 0x0D: 'REG0D VINDPM', 0x0E: 'REG0E BATV (ADC)', 0x0F: 'REG0F SYSV (ADC)', 0x10: 'REG10 TSPCT (ADC)', 0x11: 'REG11 VBUSV (ADC)', 0x12: 'REG12 ICHGR (ADC)',
                0x13: 'REG13 DPM status', 0x14: 'REG14 Part info' },
            decode: {
                0x00: v => `${bits(v, [7, 7, 'EN_HIZ'], [6, 6, 'EN_ILIM'])} IINLIM=${100 + (v & 0x3F) * 50} mA`,
                0x01: v => `${bits(v, [7, 6, 'BHOT'], [5, 5, 'BCOLD'])} VINDPM_OS=${(v & 0x1F) * 100} mV`,
                0x02: v => bits(v, [7, 7, 'CONV_START'], [6, 6, 'CONV_RATE'], [5, 5, 'BOOST_FREQ', ['1.5MHz', '500kHz']], [4, 4, 'ICO_EN'], [3, 3, 'HVDCP_EN'], [2, 2, 'MAXC_EN'], [1, 1, 'FORCE_DPDM'], [0, 0, 'AUTO_DPDM_EN']),
                0x03: v => `${bits(v, [7, 7, 'BAT_LOADEN'], [6, 6, 'WD_RST'], [5, 5, 'OTG_CONFIG'], [4, 4, 'CHG_CONFIG'])} SYS_MIN=${(3 + (v >> 1 & 7) * 0.1).toFixed(1)} V`,
                0x04: v => `EN_PUMPX=${v >> 7} ICHG=${(v & 0x7F) * 64} mA`,
                0x05: v => `IPRECHG=${64 + (v >> 4) * 64} mA ITERM=${64 + (v & 15) * 64} mA`,
                0x06: v => `VREG=${(3.84 + (v >> 2) * 0.016).toFixed(3)} V ${bits(v, [1, 1, 'BATLOWV', ['2.8V', '3.0V']], [0, 0, 'VRECHG', ['100mV', '200mV']])}`,
                0x07: v => bits(v, [7, 7, 'EN_TERM'], [6, 6, 'STAT_DIS'], [5, 4, 'WATCHDOG', ['aus', '40s', '80s', '160s']], [3, 3, 'EN_TIMER'], [2, 1, 'CHG_TIMER', ['5h', '8h', '12h', '20h']], [0, 0, 'JEITA_ISET']),
                0x08: v => `BAT_COMP=${(v >> 5) * 20} mΩ VCLAMP=${(v >> 2 & 7) * 32} mV TREG=${[60, 80, 100, 120][v & 3]} °C`,
                0x09: v => bits(v, [7, 7, 'FORCE_ICO'], [6, 6, 'TMR2X_EN'], [5, 5, 'BATFET_DIS'], [4, 4, 'JEITA_VSET'], [3, 3, 'BATFET_DLY'], [2, 2, 'BATFET_RST_EN'], [1, 1, 'PUMPX_UP'], [0, 0, 'PUMPX_DN']),
                0x0A: v => `BOOSTV=${(4.55 + (v >> 4) * 0.064).toFixed(3)} V BOOST_LIM=${['0.5A', '0.75A', '1.2A', '1.4A', '1.65A', '1.875A', '2.15A', 'res.'][v & 7]}`,
                0x0B: v => bits(v, [7, 5, 'VBUS_STAT', ['kein Eingang', 'USB SDP', 'USB CDP', 'USB DCP', 'HVDCP', 'unbekannter Adapter', 'Non-Standard', 'OTG']], [4, 3, 'CHRG_STAT', ['lädt nicht', 'Vorladung', 'Schnellladung', 'fertig']], [2, 2, 'PG_STAT'], [1, 1, 'SDP_STAT', ['100mA', '500mA']], [0, 0, 'VSYS_STAT']),
                0x0C: v => bits(v, [7, 7, 'WATCHDOG_FAULT'], [6, 6, 'BOOST_FAULT'], [5, 4, 'CHRG_FAULT', ['ok', 'Eingang', 'Übertemperatur', 'Timer']], [3, 3, 'BAT_FAULT'], [2, 0, 'NTC_FAULT', ['ok', '1', 'warm', 'kühl', '4', 'kalt', 'heiß', '7']]),
                0x0D: v => `FORCE_VINDPM=${v >> 7} VINDPM=${(2.6 + (v & 0x7F) * 0.1).toFixed(1)} V`,
                0x0E: v => `THERM_STAT=${v >> 7} BATV=${(2.304 + (v & 0x7F) * 0.02).toFixed(3)} V`,
                0x0F: v => `SYSV=${(2.304 + (v & 0x7F) * 0.02).toFixed(3)} V`,
                0x10: v => `TSPCT=${(21 + (v & 0x7F) * 0.465).toFixed(1)} % REGN`,
                0x11: v => `VBUS_GD=${v >> 7} VBUSV=${(v & 0x7F) ? (2.6 + (v & 0x7F) * 0.1).toFixed(1) : '0'} V`,
                0x12: v => `ICHGR=${(v & 0x7F) * 50} mA`,
                0x13: v => `${bits(v, [7, 7, 'VDPM_STAT'], [6, 6, 'IDPM_STAT'])} IDPM_LIM=${100 + (v & 0x3F) * 50} mA`,
                0x14: v => bits(v, [7, 7, 'REG_RST'], [6, 6, 'ICO_OPTIMIZED'], [5, 3, 'PN', { 7: 'BQ25895' }], [2, 2, 'TS_PROFILE'], [1, 0, 'DEV_REV'])
            }
        },
        {
            // Datasheet: QST QMI8658A Rev A. CTRL1.ADDR_AI is 0 after reset, so bursts would repeat one register.
            name: 'QMI8658 IMU', addresses: [0x6A, 0x6B], range: [0x00, 0x60], burst: false,
            id: { probe: async read => { const [who] = await read(0x00, 1), [rev] = await read(0x01, 1), [r14] = await read(0x14, 1); return who === 0x05 && !isBq2589x(r14) ? `QMI8658 (WHO_AM_I 0x05, Rev 0x${hex2(rev)})` : ''; } },
            regs: {
                0x00: 'WHO_AM_I', 0x01: 'REVISION_ID', 0x02: 'CTRL1', 0x03: 'CTRL2', 0x04: 'CTRL3', 0x06: 'CTRL5', 0x08: 'CTRL7', 0x09: 'CTRL8', 0x0A: 'CTRL9',
                0x0B: 'CAL1_L', 0x0C: 'CAL1_H', 0x0D: 'CAL2_L', 0x0E: 'CAL2_H', 0x0F: 'CAL3_L', 0x10: 'CAL3_H', 0x11: 'CAL4_L', 0x12: 'CAL4_H',
                0x13: 'FIFO_WTM_TH', 0x14: 'FIFO_CTRL', 0x15: 'FIFO_SMPL_CNT', 0x16: 'FIFO_STATUS', 0x17: 'FIFO_DATA',
                0x2D: 'STATUSINT', 0x2E: 'STATUS0', 0x2F: 'STATUS1', 0x30: 'TIMESTAMP_LOW', 0x31: 'TIMESTAMP_MID', 0x32: 'TIMESTAMP_HIGH',
                0x33: 'TEMP_L', 0x34: 'TEMP_H', 0x35: 'AX_L', 0x36: 'AX_H', 0x37: 'AY_L', 0x38: 'AY_H', 0x39: 'AZ_L', 0x3A: 'AZ_H',
                0x3B: 'GX_L', 0x3C: 'GX_H', 0x3D: 'GY_L', 0x3E: 'GY_H', 0x3F: 'GZ_L', 0x40: 'GZ_H',
                0x46: 'COD_STATUS', 0x49: 'dQW_L', 0x4A: 'dQW_H', 0x4B: 'dQX_L', 0x4D: 'dQY_L (0x80 = Reset ok)', 0x51: 'dVX_L', 0x52: 'dVX_H', 0x53: 'dVY_L', 0x54: 'dVY_H', 0x55: 'dVZ_L', 0x56: 'dVZ_H',
                0x59: 'TAP_STATUS', 0x5A: 'STEP_CNT_LOW', 0x5B: 'STEP_CNT_MID', 0x5C: 'STEP_CNT_HIGH', 0x60: 'RESET (0xB0 = Soft-Reset)'
            },
            decode: {
                0x00: v => v === 0x05 ? 'QST-Sensor' : 'unbekannte ID',
                0x02: v => bits(v, [7, 7, 'SIM', ['SPI 4-wire', 'SPI 3-wire']], [6, 6, 'ADDR_AI'], [5, 5, 'BE'], [4, 4, 'INT2_EN'], [3, 3, 'INT1_EN'], [2, 2, 'FIFO_INT_SEL', ['INT2', 'INT1']], [0, 0, 'SensorDisable']),
                0x03: v => bits(v, [7, 7, 'aST'], [6, 4, 'aFS', ['±2g', '±4g', '±8g', '±16g', 'n/a', 'n/a', 'n/a', 'n/a']], [3, 0, 'aODR', QMI_ACCEL_ODR]),
                0x04: v => bits(v, [7, 7, 'gST'], [6, 4, 'gFS', QMI_GYRO_FS.map(fs => `±${fs}dps`)], [3, 0, 'gODR', QMI_GYRO_ODR]),
                0x06: v => bits(v, [6, 5, 'gLPF_MODE', QMI_LPF], [4, 4, 'gLPF_EN'], [2, 1, 'aLPF_MODE', QMI_LPF], [0, 0, 'aLPF_EN']),
                0x08: v => bits(v, [7, 7, 'SyncSample'], [5, 5, 'DRDY_DIS'], [4, 4, 'gSN'], [1, 1, 'gEN'], [0, 0, 'aEN']),
                0x09: v => bits(v, [7, 7, 'CTRL9_HS', ['INT1', 'STATUSINT.7']], [6, 6, 'ACT_INT', ['INT2', 'INT1']], [4, 4, 'Pedo_EN'], [3, 3, 'SigMotion_EN'], [2, 2, 'NoMotion_EN'], [1, 1, 'AnyMotion_EN'], [0, 0, 'Tap_EN']),
                0x14: v => bits(v, [7, 7, 'FIFO_RD_MODE'], [3, 2, 'FIFO_SIZE', ['16', '32', '64', '128']], [1, 0, 'FIFO_MODE', ['Bypass', 'FIFO', 'Stream', 'res.']]),
                0x16: (v, all) => `${bits(v, [7, 7, 'FULL'], [6, 6, 'WTM'], [5, 5, 'OVFLOW'], [4, 4, 'NOT_EMPTY'])} Samples=${(v & 3) << 8 | (all.get(0x15) ?? 0)}`,
                0x2D: v => bits(v, [7, 7, 'CmdDone'], [1, 1, 'Locked'], [0, 0, 'Avail']),
                0x2E: v => bits(v, [1, 1, 'gDA'], [0, 0, 'aDA']),
                0x2F: v => bits(v, [7, 7, 'SigMotion'], [6, 6, 'NoMotion'], [5, 5, 'AnyMotion'], [4, 4, 'Pedometer'], [2, 2, 'WoM'], [1, 1, 'TAP']),
                0x32: (v, all) => all.get(0x30) == null || all.get(0x31) == null ? '' : `${v << 16 | all.get(0x31) << 8 | all.get(0x30)} Samples`,
                // Registers are named L/H; common drivers read them as little-endian pairs regardless of CTRL1.BE.
                0x34: (v, all) => lsm6Word(all, 0x33, raw => `${(raw / 256).toFixed(2)} °C`),
                ...Object.fromEntries([0x36, 0x38, 0x3A].map((reg, i) => [reg, (v, all) => lsm6Word(all, reg - 1, raw => `${'XYZ'[i]} ${(raw * QMI_ACCEL_FS[(all.get(0x03) ?? 0) >> 4 & 3] / 32768).toFixed(3)} g`)])),
                ...Object.fromEntries([0x3C, 0x3E, 0x40].map((reg, i) => [reg, (v, all) => lsm6Word(all, reg - 1, raw => `${'XYZ'[i]} ${(raw * QMI_GYRO_FS[(all.get(0x04) ?? 0) >> 4 & 7] / 32768).toFixed(2)} °/s`)])),
                0x46: v => bits(v, [7, 7, 'X_L_Fail'], [6, 6, 'X_H_Fail'], [5, 5, 'Y_L_Fail'], [4, 4, 'Y_H_Fail'], [3, 3, 'Accel_Check'], [2, 2, 'Startup_Failed'], [1, 1, 'Gyro_Enabled'], [0, 0, 'COD_Failed']),
                0x59: v => bits(v, [7, 7, 'POLARITY', ['+', '−']], [5, 4, 'AXIS', ['—', 'X', 'Y', 'Z']], [1, 0, 'NUM', ['—', 'single', 'double', 'n/a']]),
                0x5C: (v, all) => all.get(0x5A) == null || all.get(0x5B) == null ? '' : `${v << 16 | all.get(0x5B) << 8 | all.get(0x5A)} Schritte`
            }
        },
        {
            name: 'Lattice MachXO2 (Config-Port)', addresses: [0x40], range: [0, 0],
            id: { probe: async (read, address, host) => { try { await host.transfer(address, Uint8Array.of(0x74, 0, 0)); const id = await host.transfer(address, Uint8Array.of(0xE0, 0, 0, 0), 4); return (id[0] << 24 | id[1] << 16 | id[2] << 8 | id[3]) >>> 0 >> 16 === 0x012B ? `MachXO2 ID ${[...id].map(hex2).join('')}` : ''; } catch { return ''; } } },
            regs: {}, commandOnly: true
        }
    ];
    // Devices without readable registers: guessed from the address only.
    const ADDRESS_HINTS = {
        0x3C: 'SSD1306/SH1106 OLED', 0x3D: 'SSD1306/SH1106 OLED', 0x23: 'BH1750', 0x5C: 'BH1750 (ADDR=H)', 0x38: 'AHT10/AHT20 · FT6x36 · PCF8574A', 0x44: 'SHT3x / OPT3001', 0x45: 'SHT3x', 0x39: 'APDS-9960 / TSL2561', 0x1E: 'HMC5883L / LIS3MDL', 0x0C: 'AK8963 (MPU-9250)',
        0x57: 'EEPROM 24Cxx / MAX3010x', 0x50: 'EEPROM 24Cxx', 0x51: 'EEPROM 24Cxx / PCF8563', 0x20: 'PCF8574 / MCP23017', 0x27: 'PCF8574 LCD', 0x5A: 'MLX90614 / CCS811', 0x60: 'MCP4725 / Si5351', 0x62: 'SCD4x', 0x6A: 'LSM6DS3 / BQ25895 / QMI8658', 0x6B: 'LSM6DS3 / BQ25895 / QMI8658', 0x1D: 'ADXL345 / LIS3DH', 0x53: 'ADXL345', 0x18: 'LIS3DH / MCP9808', 0x36: 'MAX17048 / AS5600', 0x34: 'AXP192 / AXP2101'
    };
    const knownCandidates = address => DEVICES.filter(device => device.addresses.includes(address));

    module.exports = {
        id: 'i2c-analyzer',
        name: 'I²C Analyzer',
        version: '1.0',
        description: 'Bus-Scan, Geräteerkennung per ID-Register und Registermap mit Klartextnamen und Bitfeld-Dekodierung.',
        interfaces: [{ id: 'bus', kinds: ['i2c'], label: 'I²C-Bus' }],
        async load(api) {
            const host = api.interfaces.bus.host, found = new Map();
            const fifo = Math.max(2, (host.info?.[5] ?? 16) - 2);
            const read8 = async (address, reg, count) => host.transfer(address, Uint8Array.of(reg), count);
            const rangeText = value => { const n = parseInt(value, 16); if (!Number.isInteger(n) || n < 0 || n > 0xFFFF) throw new Error(`Ungültiger Hex-Wert: ${value}`); return n; };

            const scan = api.ui.block('Bus-Scan');
            const scanRow = scan.row(), scanTable = scan.table(['Adresse', 'Dez', 'Erkannt', 'Mögliche Geräte']), scanProgress = scan.text('');
            const identify = async address => {
                const result = [];
                for (const device of knownCandidates(address)) {
                    try {
                        if (device.id?.probe) { const text = await device.id.probe((reg, count) => read8(address, reg, count), address, host); if (text) result.push({ device, text }); }
                        else if (device.id) { const [value] = await read8(address, device.id.reg, 1); const text = device.id.values[value]; if (text) result.push({ device, text: `${text} (ID 0x${hex2(value)})` }); }
                    } catch { /* NACK or bus error: not this device */ }
                }
                return result;
            };
            scanRow.button('Adressen scannen · 0x03–0x77', async () => {
                found.clear(); scanTable.set([]);
                scan.setStatus('Scan läuft …');
                const addresses = await host.scan({ signal: api.signal, onProgress: address => { scanProgress.textContent = `Prüfe 0x${hex2(address)} …`; } });
                const rows = [];
                for (const address of addresses) {
                    const identified = await identify(address);
                    found.set(address, identified);
                    rows.push([`0x${hex2(address)}`, address, identified.map(item => item.text).join(' | ') || '—', ADDRESS_HINTS[address] || knownCandidates(address).map(d => d.name).join(' / ') || '—']);
                }
                scanTable.set(rows);
                scanProgress.textContent = `${addresses.length} Gerät(e) gefunden.`;
                scan.setStatus(`${addresses.length} gefunden`);
                refreshAddresses();
            }, { primary: true });

            const dump = api.ui.block('Registermap');
            const controls = dump.row();
            const addressField = controls.field('Adresse', { options: [['', 'zuerst scannen …']] });
            const deviceField = controls.field('Registerkarte', { options: [['auto', 'Automatisch']].concat(DEVICES.map((d, i) => [String(i), d.name]), [['raw', 'Roh 0x00–0xFF']]) });
            const startField = controls.field('Start', { value: '00', width: '60px' }), endField = controls.field('Ende', { value: 'FF', width: '60px' });
            const manual = dump.row(), manualAddress = manual.field('oder manuell 0x', { value: '', width: '60px' });
            const table = dump.table(['Reg', 'Hex', 'Dez', 'Bin', 'Name', 'Bedeutung']), summary = dump.text('');
            let lastDump = null;
            function refreshAddresses() {
                const select = addressField.input, previous = select.value;
                select.replaceChildren(...(found.size ? [...found.keys()].map(a => new Option(`0x${hex2(a)}`, a)) : [new Option('zuerst scannen …', '')]));
                if ([...select.options].some(o => o.value === previous)) select.value = previous;
            }
            const currentAddress = () => manualAddress.value.trim() ? parseInt(manualAddress.value, 16) : Number(addressField.value);
            const currentDevice = address => {
                if (deviceField.value === 'raw') return null;
                if (deviceField.value !== 'auto') return DEVICES[Number(deviceField.value)];
                return found.get(address)?.[0]?.device || knownCandidates(address)[0] || null;
            };
            async function readRegisters(address, device, start, end) {
                const rows = [], values = new Map(), name = reg => device?.regs[reg] || '';
                const targets = [];
                if (device?.width === 2) { for (let reg = start; reg <= end; reg++) targets.push(reg); for (const reg of device.extra || []) if (reg > end) targets.push(reg); }
                if (device?.width === 2) {
                    for (const reg of targets) {
                        dump.setStatus(`Lese 0x${hex2(reg)} …`);
                        try { const [hi, lo] = await read8(address, reg, 2); values.set(reg, hi << 8 | lo); } catch { values.set(reg, null); }
                    }
                } else {
                    for (let reg = start; reg <= end;) {
                        if (api.signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
                        const count = device?.burst === false ? 1 : Math.min(fifo, end - reg + 1);
                        dump.setStatus(`Lese 0x${hex2(reg)}–0x${hex2(reg + count - 1)} …`);
                        try { const data = await read8(address, reg, count); data.forEach((v, i) => values.set(reg + i, v)); }
                        catch {
                            // Some devices NACK unmapped ranges: retry byte-wise to keep the readable registers.
                            for (let i = 0; i < count; i++) { try { values.set(reg + i, (await read8(address, reg + i, 1))[0]); } catch { values.set(reg + i, null); } }
                        }
                        reg += count;
                    }
                }
                const digits = device?.width === 2 ? 4 : 2;
                for (const [reg, value] of values) {
                    const known = name(reg), meaning = value !== null && device?.decode?.[reg] ? device.decode[reg](value, values) : '';
                    if (value === null) rows.push([`0x${hex2(reg)}`, '--', '', '', known, 'keine Antwort']);
                    else rows.push([`0x${hex2(reg)}`, '0x' + value.toString(16).toUpperCase().padStart(digits, '0'), value, value.toString(2).padStart(digits * 4, '0'), known, meaning]);
                }
                return { values, rows };
            }
            controls.button('Register lesen', async () => {
                const address = currentAddress();
                if (!Number.isInteger(address) || address < 3 || address > 0x77) throw new Error('Adresse 0x03–0x77 wählen.');
                const device = currentDevice(address);
                const start = deviceField.value === 'raw' || !device ? rangeText(startField.value) : (startField.value.trim() === '' ? device.range[0] : rangeText(startField.value));
                const end = rangeText(endField.value);
                if (end < start) throw new Error('Ende liegt vor dem Start.');
                const { values, rows } = await readRegisters(address, device, start, Math.min(end, 0xFFFF));
                table.set(rows);
                lastDump = { address, device: device?.name || 'unbekannt', registers: Object.fromEntries([...values].map(([reg, v]) => [`0x${hex2(reg)}`, v === null ? null : v])) };
                const ok = [...values.values()].filter(v => v !== null).length;
                summary.textContent = `${device?.name || 'Rohdaten'} @ 0x${hex2(address)} · ${ok}/${values.size} Register gelesen.`;
                dump.setStatus('');
            });
            controls.button('JSON ↓', () => {
                if (!lastDump) throw new Error('Noch keine Registerdaten.');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(lastDump, null, 2)], { type: 'application/json' }));
                a.download = `i2c-0x${hex2(lastDump.address)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }, { raw: true });

            const write = api.ui.block('Register schreiben');
            const writeRow = write.row();
            const wAddress = writeRow.field('Adresse 0x', { value: '', width: '60px' }), wReg = writeRow.field('Register 0x', { value: '00', width: '60px' }), wValue = writeRow.field('Wert (Hex-Bytes)', { value: '00', width: '120px' });
            writeRow.button('Schreiben', async () => {
                const address = parseInt(wAddress.value || addressField.value, 16 * (wAddress.value ? 1 : 0) || 10);
                if (!Number.isInteger(address) || address < 3 || address > 0x77) throw new Error('Adresse 0x03–0x77 eingeben.');
                if (!window.confirm(`0x${hex2(address)}: Register 0x${wReg.value} schreiben? Das verändert das Gerät.`)) return;
                const payload = Uint8Array.of(parseInt(wReg.value, 16), ...api.util.parseHex(wValue.value));
                await host.transfer(address, payload, 0, api.signal);
                write.setStatus(`Geschrieben: ${[...payload].map(hex2).join(' ')}`);
            });
        }
    };
})();
