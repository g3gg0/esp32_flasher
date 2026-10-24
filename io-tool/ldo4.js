(function (root) {
    'use strict';
    const ldo4Profiles = typeof module === 'object' && module.exports ? require('./configs/ldo4.js') : root.ESPIO.ldo4Profiles;
    class LDO4 {
        constructor(transport, profile) { this.transport = transport; this.profile = profile; this.state = null; }
        affects(id) { return this.profile.pins.includes(id); }
        async refresh() {
            const p = this.profile;
            this.state = null;
            const control = await this.transport.read(p.control);
            const analog = await this.transport.read(p.analog);
            this.state = {
                control, analog, enabled: !!(control & p.enable),
                bypass: (control & p.mask) === p.bypass
            };
            return this.state;
        }
        async setMode(mode) {
            if (!['off', 'bypass'].includes(mode)) throw new Error('LDO4: nur Aus oder 3,3-V-Rail-Bypass unterstützt.');
            const p = this.profile;
            this.state = null;
            if (mode === 'bypass') await this.transport.write(p.analog, p.voltageDetector, p.voltageDetector);
            await this.transport.write(p.control, mode === 'bypass' ? p.bypass : 0, p.mask);
            await new Promise(resolve => setTimeout(resolve, 10));
            const state = await this.refresh();
            if (mode === 'bypass' ? !state.bypass || !(state.analog & p.voltageDetector) : state.enabled) {
                this.state = null;
                throw new Error('LDO4-Einstellung wurde beim Register-Readback nicht bestätigt.');
            }
            return state;
        }
    }
    const api = { LDO4, ldo4Profiles };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
