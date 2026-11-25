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
