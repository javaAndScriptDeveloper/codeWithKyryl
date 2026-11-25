// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const CodeLabel = require('../assets/js/code-label.js');

test('names the language from the Rouge wrapper class', () => {
    assert.equal(CodeLabel.languageLabel('language-java highlighter-rouge'), 'Java');
    assert.equal(CodeLabel.languageLabel('language-sql highlighter-rouge'), 'SQL');
    assert.equal(CodeLabel.languageLabel('language-kotlin highlighter-rouge'), 'Kotlin');
    assert.equal(CodeLabel.languageLabel('language-yaml highlighter-rouge'), 'YAML');
});

test('gives no label to blocks without a real language', () => {
    assert.equal(CodeLabel.languageLabel('language-plaintext highlighter-rouge'), null);
    assert.equal(CodeLabel.languageLabel('language-text highlighter-rouge'), null);
    assert.equal(CodeLabel.languageLabel('language-mermaid highlighter-rouge'), null);
    assert.equal(CodeLabel.languageLabel('highlight'), null);
    assert.equal(CodeLabel.languageLabel(''), null);
});

test('falls back to the upper-cased name for languages it does not know', () => {
    assert.equal(CodeLabel.languageLabel('language-hcl highlighter-rouge'), 'HCL');
});
