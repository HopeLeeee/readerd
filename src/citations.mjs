import {
  extractCitationMarkers,
  parseCitationNumbers,
} from "./analysis/index.js";
import { indexText, makeRange } from "./words/companion.js";

function resolve(marker, referenceList) {
  const byNumber = new Map(
    referenceList.map((reference) => [Number(reference.number), reference]),
  );
  return {
    ...marker,
    references: marker.numbers
      .filter((number) => byNumber.has(number))
      .map((number) => byNumber.get(number)),
    missingNumbers: marker.numbers.filter((number) => !byNumber.has(number)),
  };
}

/** Text offsets refer to the indexText string, including its synthetic whitespace. */
export function matchIndexedCitations(indexed, referenceList = []) {
  const text = typeof indexed === "string" ? indexed : indexed.text;
  return [...text.matchAll(/\[[^\[\]]+\]/g)].flatMap((match) => {
    const validated = extractCitationMarkers(
      `[${match[0].slice(1, -1).trim()}]`,
    )[0];
    return validated
      ? [
          resolve(
            {
              ...validated,
              text: match[0],
              start: match.index,
              end: match.index + match[0].length,
              kind: "bracket",
            },
            referenceList,
          ),
        ]
      : [];
  });
}

function median(values) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function superscriptMatches(indexed, references, doc, brackets) {
  const segments = indexed.segments.map((segment) => ({
    ...segment,
    rect: segment.node.parentElement.getBoundingClientRect(),
  }));
  const body = segments
    .filter((segment) => /[\p{L}]{3}/u.test(segment.node.nodeValue))
    .map((segment) => segment.rect.height);
  const bodyHeight = median(body);
  if (!bodyHeight) return [];
  const results = [];
  for (const match of indexed.text.matchAll(
    /\b\d+(?:\s*[,;，–—−-]\s*\d+)*\b/g,
  )) {
    const start = match.index,
      end = start + match[0].length;
    if (brackets.some((marker) => marker.start <= start && marker.end >= end))
      continue;
    const numbers = parseCitationNumbers(match[0]);
    if (!numbers.length) continue;
    const selected = segments.filter(
      (segment) => segment.start < end && segment.end > start,
    );
    // A superscript marker must occupy its own small text span. This excludes
    // normal dates, measurements and equation numbers embedded in body spans.
    if (
      !selected.length ||
      selected.some(
        (segment) =>
          segment.rect.height > bodyHeight * 0.82 ||
          !/^[\d\s,;，–—−-]+$/.test(segment.node.nodeValue),
      )
    )
      continue;
    const range = makeRange(doc, indexed.segments, start, end);
    if (!range) continue;
    const rect = range.getBoundingClientRect();
    const neighbor = segments.find(
      (segment) =>
        /[\p{L}]{3}/u.test(segment.node.nodeValue) &&
        segment.rect.height >= bodyHeight * 0.9 &&
        segment.rect.height <= bodyHeight * 1.15 &&
        Math.abs(segment.rect.bottom - rect.bottom) >= bodyHeight * 0.15 &&
        rect.bottom < segment.rect.bottom &&
        rect.top >= segment.rect.top - bodyHeight * 0.4 &&
        rect.bottom > segment.rect.top &&
        Math.min(
          Math.abs(rect.left - segment.rect.right),
          Math.abs(segment.rect.left - rect.right),
        ) <
          bodyHeight * 2.5,
    );
    if (neighbor)
      results.push(
        resolve(
          {
            text: match[0],
            start,
            end,
            numbers,
            kind: "superscript",
            uncertainty: "上标数字按版面推断，可能是脚注或公式。",
          },
          references,
        ),
      );
  }
  return results;
}

/** Bind non-destructive PDF citation hit-testing. onHide is immediate: the host
 * owns the 350ms card dismissal timer so the card itself can cancel dismissal. */
export function bindCitationHover({
  container,
  textLayer,
  references = [],
  onShow = () => {},
  onHide = () => {},
}) {
  const doc = container.ownerDocument;
  const indexed = indexText(textLayer);
  const brackets = matchIndexedCitations(indexed, references);
  const matches = [
    ...brackets,
    ...superscriptMatches(indexed, references, doc, brackets),
  ];
  const hits = matches
    .map((match) => ({
      ...match,
      range: makeRange(doc, indexed.segments, match.start, match.end),
    }))
    .filter((hit) => hit.range);
  let active = null,
    timer,
    disposed = false,
    visible = false;
  const hide = () => {
    clearTimeout(timer);
    active = null;
    if (visible) {
      visible = false;
      onHide();
    }
  };
  const selected = () => {
    const selection = doc.getSelection?.();
    return selection && !selection.isCollapsed;
  };
  const move = (event) => {
    if (event.buttons || selected()) {
      hide();
      return;
    }
    const hit = hits.find((candidate) =>
      [...candidate.range.getClientRects()].some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom,
      ),
    );
    if (hit === active) return;
    hide();
    if (!hit) return;
    active = hit;
    const x = event.clientX,
      y = event.clientY;
    timer = setTimeout(() => {
      if (disposed || active !== hit || selected()) return;
      visible = true;
      onShow({
        references: hit.references,
        missingNumbers: hit.missingNumbers,
        x,
        y,
        numbers: hit.numbers,
        kind: hit.kind,
        uncertainty: hit.uncertainty || null,
      });
    }, 220);
  };
  const selectionChanged = () => {
    if (selected()) hide();
  };
  container.addEventListener("pointermove", move, { passive: true });
  container.addEventListener("pointerleave", hide);
  container.addEventListener("pointerdown", hide);
  doc.addEventListener("selectionchange", selectionChanged);
  return () => {
    disposed = true;
    hide();
    container.removeEventListener("pointermove", move);
    container.removeEventListener("pointerleave", hide);
    container.removeEventListener("pointerdown", hide);
    doc.removeEventListener("selectionchange", selectionChanged);
  };
}
