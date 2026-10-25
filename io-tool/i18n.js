(function (root) {
    'use strict';
    const dictionaries = root.ESPIO?.locales || {};
    const normalize = value => String(value).replace(/\s+/g, ' ').trim();
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const language = value => {
        const code = String(value || '').toLowerCase().split(/[-_]/)[0];
        return code === 'en' || dictionaries[code] ? code : 'en';
    };
    const browserLocale = () => root.navigator?.languages?.[0] || root.navigator?.language || 'en';
    let preference = 'auto';
    try { preference = new URLSearchParams(root.location?.search || '').get('lang') || (root.document && root.localStorage?.getItem('esp-io-language')) || 'auto'; } catch (_) { /* Storage may be disabled. */ }
    let locale = preference === 'auto' ? language(browserLocale()) : language(preference);
    const english = new Map(), patterns = [], cache = new Map();
    for (const dictionary of Object.values(dictionaries)) for (const [en, translated] of Object.entries(dictionary.messages || {})) {
        english.set(normalize(en), en); english.set(normalize(translated), en);
        if (/\{\d+\}/.test(en)) {
            for (const source of [en, translated]) {
                const ids = [], chunks = normalize(source).split(/(\{\d+\})/g);
                const fixed = chunks.filter(chunk => !/^\{\d+\}$/.test(chunk));
                if (fixed.join('').replace(/[^\p{L}]/gu, '').length < 3) continue;
                const regex = new RegExp('^' + chunks.map(chunk => {
                    if (!/^\{\d+\}$/.test(chunk)) return escape(chunk);
                    ids.push(Number(chunk.slice(1, -1))); return '([\\s\\S]*?)';
                }).join('') + '$');
                patterns.push({ en, regex, ids, fixed: fixed.filter(Boolean), weight: fixed.join('').length });
            }
        }
    }
    patterns.sort((a, b) => b.weight - a.weight);

    function translate(value, depth = 0) {
        const text = String(value ?? '');
        if (!text || !/\p{L}/u.test(text) || /^(?:https?:|data:|0x[\da-f]+$)/i.test(text)) return text;
        if (depth === 0 && cache.has(text)) return cache.get(text);
        if (text.includes('\n') && depth < 3) return text.split('\n').map(line => translate(line, depth + 1)).join('\n');
        const key = normalize(text);
        let result;
        if (english.has(key)) {
            const en = english.get(key);
            result = dictionaries[locale]?.messages[en] ?? en;
        } else if (depth < 3) {
            for (const pattern of patterns) {
                if (!pattern.fixed.every(part => key.includes(part))) continue;
                const match = pattern.regex.exec(key);
                if (!match) continue;
                const values = new Map(pattern.ids.map((id, index) => [id, match[index + 1]]));
                result = (dictionaries[locale]?.messages[pattern.en] ?? pattern.en).replace(/\{(\d+)\}/g, (_, id) => translate(values.get(Number(id)) ?? '', depth + 1));
                break;
            }
            // Joined board tooltips and logs retain their separators and data.
            if (result === undefined && /\n| · | {2,}/.test(text)) {
                result = text.split(/(\n| · | {2,})/g).map(part => /^\n$|^ · $|^ {2,}$/.test(part) ? part : translate(part, depth + 1)).join('');
            }
        }
        if (result === undefined) result = text;
        else result = text.match(/^\s*/)[0] + result.trim() + text.match(/\s*$/)[0];
        if (depth === 0) { if (cache.size > 2048) cache.clear(); cache.set(text, result); }
        return result;
    }

    const attributes = ['title', 'aria-label', 'placeholder', 'alt'];
    const skip = 'script,style,code,[translate="no"],[data-i18n-ignore],#fuses-records tbody,#register-list .register-address';
    function localizeNode(node) {
        if (node.nodeType === 3) {
            if (node.parentElement?.closest(skip + ',textarea')) return;
            const translated = translate(node.nodeValue);
            if (translated !== node.nodeValue) node.nodeValue = translated;
        } else if (node.nodeType === 1) {
            if (node.closest(skip)) return;
            for (const name of attributes) if (node.hasAttribute(name)) {
                const value = node.getAttribute(name), translated = translate(value);
                if (translated !== value) node.setAttribute(name, translated);
            }
            if (node.tagName === 'TEXTAREA') return;
            for (const child of node.childNodes) localizeNode(child);
        }
    }
    function setLocale(value, persist = true) {
        preference = value === 'auto' ? 'auto' : language(value);
        locale = preference === 'auto' ? language(browserLocale()) : preference;
        cache.clear();
        if (persist && root.document) try { root.localStorage?.setItem('esp-io-language', preference); } catch (_) { /* Optional. */ }
        if (root.document) {
            root.document.documentElement.lang = locale;
            localizeNode(root.document.documentElement);
            const selector = root.document.getElementById('language'); if (selector) selector.value = preference;
        }
        root.dispatchEvent?.(new Event('esp-i18n-change'));
        return locale;
    }
    const api = { t: translate, setLocale, get locale() { return locale; }, get preference() { return preference; }, localize: localizeNode };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else (root.ESPIO ||= {}).i18n = api;
    if (root.document) root.document.addEventListener('DOMContentLoaded', () => {
        // Observe only DOM output. GPIO state, form values, register IDs and source data stay intact.
        const observer = new MutationObserver(records => {
            const roots = new Set();
            for (const record of records) {
                if (record.type === 'childList') for (const node of record.addedNodes) roots.add(node);
                else roots.add(record.target);
            }
            for (const node of roots) if (node.isConnected) localizeNode(node);
        });
        observer.observe(root.document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
        const selector = root.document.getElementById('language'); selector?.addEventListener('change', () => setLocale(selector.value));
        setLocale(preference, false);
    });
})(globalThis);
