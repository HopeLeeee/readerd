import test from 'node:test';
import assert from 'node:assert/strict';
import {matchIndexedCitations} from '../src/citations.mjs';

const references = Array.from({length: 14}, (_, index) => ({number: index + 1, title: `Paper ${index + 1}`}));

test('finds bracket citations inside complete sentence text spans', () => {
  const result = matchIndexedCitations({text: 'Previous evidence [3, 5, 8–11] supports this claim.'}, references);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].references.map(reference => reference.number), [3, 5, 8, 9, 10, 11]);
  assert.equal(result[0].start, 18);
  assert.deepEqual(result[0].missingNumbers, []);
});

test('handles indexText whitespace between split PDF spans without truncating lists', () => {
  const text = 'Evidence [\n3 , 5 , 8 –\n11 ] is consistent with [1–14].';
  const result = matchIndexedCitations({text, segments: []}, references);
  assert.equal(result.length, 2);
  assert.equal(result[1].references.length, 14);
  assert.deepEqual(result[0].numbers, [3, 5, 8, 9, 10, 11]);
  assert.equal(text.slice(result[0].start, result[0].end), '[\n3 , 5 , 8 –\n11 ]');
});

test('missing references remain explicit instead of substituting other entries', () => {
  const result = matchIndexedCitations('See [1, 15, 17–18].', references)[0];
  assert.deepEqual(result.references.map(reference => reference.number), [1]);
  assert.deepEqual(result.missingNumbers, [15, 17, 18]);
});

test('plain body numbers are not guessed as citations by the text matcher', () => {
  assert.deepEqual(matchIndexedCitations('In 2024 we measured 12 mg and equation (3).', references), []);
  assert.deepEqual(matchIndexedCitations('Invalid [9–2].', references), []);
});
