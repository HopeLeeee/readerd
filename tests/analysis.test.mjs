import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeDocument, parseCitationNumbers, extractCitationMarkers, recommendReferences} from '../src/analysis/index.js';

test('expands grouped citation ranges without accepting reversed or huge ranges', () => {
  assert.deepEqual(parseCitationNumbers('[3, 5, 8–11]'), [3, 5, 8, 9, 10, 11]);
  assert.deepEqual(parseCitationNumbers('[8–3]'), []);
  assert.deepEqual(parseCitationNumbers('[1–9999]'), []);
  assert.equal(extractCitationMarkers('See [3, 5] and [8–11].')[1].start, 15);
});

const item = (str, x, y, height = 10, width = 220) => ({str, x, y, height, width, fontName: 'Times'});
test('finds headings and keeps wrapped two-column references in reading order', () => {
  const result = analyzeDocument([{page: 1, width: 600, height: 800, items: [
    item('1 Introduction', 40, 40, 14), item('A long body paragraph describing scientific evidence and results.', 40, 70),
    item('References', 40, 200, 14),
    item('[1] Smith A. (2020). Microbial metabolism.', 40, 230),
    item('Nature. doi:10.1000/example', 40, 245),
    item('[2] Jones B. (2021). Nicotinamide conversion.', 40, 270),
    item('Cell.', 40, 285),
    item('[3] Lee C. (2022). Another topic.', 330, 230),
    item('Science.', 330, 245),
    item('[4] Doe D. (2023). Last topic.', 330, 270),
    item('Journal.', 330, 285),
  ]}]);
  assert.equal(result.outline[0].title, '1 Introduction');
  assert.deepEqual(result.references.map(reference => reference.number), [1, 2, 3, 4]);
  assert.equal(result.references[0].doi, '10.1000/example');
  assert.equal(result.references[0].title, 'Microbial metabolism');
  assert.match(result.references[1].raw, /Cell/);
  assert.doesNotMatch(result.references[1].raw, /Science/);
});

test('preserves supplied native outline and does not invent unnumbered references', () => {
  const native = [{title: 'Original heading', page: 2, y: 30, level: 1}];
  const result = analyzeDocument([{page: 1, width: 600, height: 800, items: [item('Some ordinary text.', 40, 40)]}], native);
  assert.deepEqual(result.outline, native);
  assert.deepEqual(result.references, []);
});

test('reference continuation above left-column section heading is retained', () => {
  const result = analyzeDocument([{page: 1, width: 600, height: 800, items: [
    item('References', 40, 400, 14), item('[1] Smith A. (2020). First title.', 40, 430),
    item('Nature.', 40, 445), item('[2] Doe B. (2021). Second title.', 330, 50),
    item('Cell.', 330, 65), item('[3] Lee C. (2022). Third title.', 330, 90),
    item('Science.', 330, 105),
  ]}]);
  assert.deepEqual(result.references.map(reference => reference.number), [1, 2, 3]);
  assert.match(result.references[1].raw, /Cell/);
});

test('ranking is bounded, deduplicated and explains title-only evidence', () => {
  const refs = [{number: 1, title: 'RNA sequencing'}, {number: 2, title: 'Nicotinamide microbial metabolism'},
    {number: 3, title: 'Nicotinamide microbial metabolism'}, {number: 4, title: 'Protein structures'}, {number: 5, title: 'Microbial metabolism in vivo'}];
  const ranked = recommendReferences(refs, {direction: 'microbial nicotinamide', interests: [], history: []});
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].number, 2);
  assert.equal(ranked[0].evidence, 'title-only');
  assert.ok(ranked[0].matchedTerms.includes('nicotinamide'));
});
