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

function fakeBlock(className) {
    const classes = new Set(className.split(' '));
    const children = [];
    return {
        className,
        classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
        querySelector: (sel) => (sel === 'pre' ? {} : children.find((c) => c.className === 'code-lang') || null),
        appendChild: (c) => children.push(c),
        children
    };
}

test('marks only labelled blocks, so unlabelled ones keep normal padding', () => {
    global.document = { createElement: () => ({}) };
    const java = fakeBlock('language-java highlighter-rouge');
    const plain = fakeBlock('language-plaintext highlighter-rouge');
    CodeLabel.mount({ querySelectorAll: () => [java, plain] });

    assert.equal(java.classList.contains('has-lang'), true);
    assert.equal(plain.classList.contains('has-lang'), false);
    delete global.document;
});
