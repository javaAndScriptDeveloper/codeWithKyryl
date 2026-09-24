// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ShareCard = require('../assets/js/share-card.js');

const result = {
    slug: 'kafka-senior',
    title: 'Apache Kafka — Production Decisions',
    score: 9,
    total: 10,
    url: 'https://codewithkyryl.dev/quizzes/kafka-senior/'
};

// Fixed-width font: every character is 10px wide.
const measure = (text) => text.length * 10;

test('post text states the score and points to the link in the comments, without the link', () => {
    const text = ShareCard.postText(result);

    assert.match(text, /9\/10 on Apache Kafka — Production Decisions/);
    assert.match(text, /comments/i);
    assert.doesNotMatch(text, /https?:\/\//);
});

test('file name is a slug with the score, safe for any file system', () => {
    assert.equal(ShareCard.fileName(result), 'codewithkyryl-kafka-senior-9-of-10.png');
});

test('file name strips characters that are unsafe in a slug', () => {
    assert.equal(ShareCard.fileName({ ...result, slug: 'Kafka Lab/v2' }), 'codewithkyryl-kafka-lab-v2-9-of-10.png');
});

test('wrapLines keeps words whole and breaks at the width limit', () => {
    assert.deepEqual(ShareCard.wrapLines('Apache Kafka Production', 130, measure, 3),
        ['Apache Kafka', 'Production']);
});

test('wrapLines ellipsizes the last allowed line when the text does not fit', () => {
    const lines = ShareCard.wrapLines('one two three four five six', 90, measure, 2);

    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'one two');
    assert.ok(lines[1].endsWith('…'), `expected ellipsis, got "${lines[1]}"`);
    assert.ok(measure(lines[1]) <= 90, `"${lines[1]}" is wider than the limit`);
});

test('wrapLines hard-breaks a single word wider than the limit', () => {
    const lines = ShareCard.wrapLines('Kafka', 30, measure, 1);

    assert.equal(lines.length, 1);
    assert.ok(measure(lines[0]) <= 30, `"${lines[0]}" is wider than the limit`);
});

test('display URL drops the protocol and trailing slash', () => {
    assert.equal(ShareCard.displayUrl(result.url), 'codewithkyryl.dev/quizzes/kafka-senior');
});
