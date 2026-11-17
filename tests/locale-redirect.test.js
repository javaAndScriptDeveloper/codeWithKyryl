// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../_includes/locale-redirect.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const store = (init = {}) => {
    const data = { ...init };
    return {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
    };
};

// Runs the English-home redirect script; returns the URL it navigated to (or null).
function visitHome({ local = {}, session = {}, languages = ['en-US'], navType = 'navigate' } = {}) {
    let target = null;
    const localStorage = store(local);
    const ctx = {
        localStorage,
        sessionStorage: store(session),
        navigator: { languages, language: languages[0] },
        performance: { getEntriesByType: () => [{ type: navType }] },
        window: { location: { replace: (u) => { target = u; } } },
    };
    vm.runInNewContext(script, ctx);
    return target;
}

test('saved choice is applied when "/" is opened in a fresh tab, not the browser language', () => {
    assert.equal(visitHome({ local: { cwk_lang_choice: 'de' }, languages: ['fr-FR'] }), '/de/');
});

test('saved choice is applied on every visit to "/", not once per session', () => {
    assert.equal(
        visitHome({ local: { cwk_lang_choice: 'de' }, session: { cwk_locale_routed: '1' } }),
        '/de/'
    );
});

test('saved English choice keeps English even if the browser prefers another language', () => {
    assert.equal(visitHome({ local: { cwk_lang_choice: 'en' }, languages: ['fr-FR'] }), null);
});

test('unknown saved value is ignored and falls back to browser language', () => {
    assert.equal(visitHome({ local: { cwk_lang_choice: 'xx' }, languages: ['fr-FR'] }), '/fr/');
});

test('without a saved choice, browser language still routes first-time visitors', () => {
    assert.equal(visitHome({ languages: ['uk-UA'] }), '/uk/');
});
