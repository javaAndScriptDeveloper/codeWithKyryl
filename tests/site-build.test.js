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
