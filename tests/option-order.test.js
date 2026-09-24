// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { optionOrder } = require('../assets/js/option-order.js');

// Deterministic stand-in for Math.random: replays the given values in order.
const sequence = (...values) => () => values.shift();

test('returns every original index exactly once', () => {
    const order = optionOrder({ type: 'single', options: ['a', 'b', 'c', 'd'] }, Math.random);

    assert.deepEqual([...order].sort(), [0, 1, 2, 3]);
});

test('moves options away from their authored position', () => {
    // Fisher-Yates from the end: i=3 swaps with 0, i=2 swaps with 0, i=1 swaps with 0.
    const order = optionOrder({ type: 'single', options: ['a', 'b', 'c', 'd'] }, sequence(0, 0, 0));

    assert.deepEqual(order, [1, 2, 3, 0]);
});

test('keeps true/false questions in their authored order', () => {
    const order = optionOrder({ type: 'boolean', options: ['True', 'False'] }, sequence(0));

    assert.deepEqual(order, [0, 1]);
});

test('shuffles multi-select questions too', () => {
    const order = optionOrder({ type: 'multi', options: ['a', 'b', 'c'] }, sequence(0, 0));

    assert.deepEqual(order, [1, 2, 0]);
});
