(function (root) {
    'use strict';
    // ESP-IDF v5.5.1: esp32p4/hal/ldo_ll.h and soc/pmu_reg.h.
    const ldo4Profiles = {
        esp32p4: {
            control: 0x501151d8, analog: 0x501151dc,
            mask: 0x4f80, bypass: 0x4180, enable: 1 << 8, voltageDetector: 1 << 26,
            pins: [39, 40, 41, 42, 43, 44, 45, 46, 47, 48],
            description: 'LDO4 versorgt GPIO39–48. Separate Stromversorgung; GPIO-Konfiguration und SDMMC schalten sie nicht automatisch.'
        }
    };
    if (typeof module === 'object' && module.exports) module.exports = ldo4Profiles;
    else (root.ESPIO ||= {}).ldo4Profiles = ldo4Profiles;
})(globalThis);
