// Checks the built site. Build first: bundle exec jekyll build
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SITE = path.join(__dirname, '..', '_site');

test('companion examples are not published', () => {
    assert.equal(fs.existsSync(path.join(SITE, 'examples')), false);
});

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
    });
}

const HIDDEN = /dspy-gepa-vs-miprov2|harness2-how-to|jev-how-to/;
const TEXT = /\.(html|xml|txt|json)$/;

test('hidden articles have no page and no link in the site', () => {
    const offenders = walk(SITE)
        .filter((f) => !f.includes(`${path.sep}assets${path.sep}`))
        .filter((f) => HIDDEN.test(path.relative(SITE, f)) ||
            (TEXT.test(f) && HIDDEN.test(fs.readFileSync(f, 'utf8'))))
        .map((f) => path.relative(SITE, f));
    assert.deepEqual(offenders, []);
});

const OUTBOX = path.join(SITE, '2026', '06', '07', 'outboxes', 'index.html');

test('posts load a pinned Mermaid with the hand-drawn look', () => {
    const html = fs.readFileSync(OUTBOX, 'utf8');
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid@11\.17\.2\/dist\/mermaid\.min\.js/);
    assert.match(html, /look:\s*'handDrawn'/);
    assert.match(html, /fonts\.googleapis\.com\/css2\?family=Kalam/);
});

// Google Search Console flagged "Alternate page with proper canonical tag": English tutorials
// was built as /tutorials.html while the nav links /tutorials, so Netlify served both URLs
// with a canonical pointing at the .html one. Every page must sit at a trailing-slash URL.
test('English tutorials page lives at /tutorials/, like every other page', () => {
    assert.equal(fs.existsSync(path.join(SITE, 'tutorials', 'index.html')), true);
    assert.equal(fs.existsSync(path.join(SITE, 'tutorials.html')), false);
    const html = fs.readFileSync(path.join(SITE, 'tutorials', 'index.html'), 'utf8');
    assert.match(html, /<link rel="canonical" href="https:\/\/codewithkyryl\.dev\/tutorials\/"/);
});

test('no canonical or hreflang URL ends in .html', () => {
    const bad = walk(SITE)
        .filter((f) => f.endsWith('.html') && f !== path.join(SITE, '404.html') && !f.includes(`${path.sep}assets${path.sep}`))
        .filter((f) => /<link rel="(canonical|alternate)"[^>]*href="[^"]*\.html"/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(SITE, f));
    assert.deepEqual(bad, []);
});
