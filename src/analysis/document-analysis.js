/** PDF text analysis. Coordinates use PDF.js viewport space (origin at top left). */
const REFERENCE_HEADING =
  /^(?:references(?: and notes)?|bibliography|literature cited|参考文献)\s*[:：]?$/i;
const SECTION_HEADING =
  /^(?:\d+(?:\.\d+)*[.)]?\s+\S.{1,110}|abstract|introduction|background|methods?|materials and methods|results|discussion|conclusions?|acknowledg(?:e)?ments|references|bibliography|摘要|引言|方法|结果|讨论|结论|参考文献)$/i;

export function parseCitationNumbers(value) {
  const text = String(value)
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/[−–—]/g, "-");
  if (!/^\d+(?:\s*[-,;，]\s*\d+)*$/.test(text)) return [];
  const numbers = [];
  for (const part of text.split(/[,;，]/)) {
    const [start, end = start] = part.trim().split("-").map(Number);
    if (start < 1 || end < start || end - start > 100 || end > 9999) return [];
    for (let number = start; number <= end; number++) numbers.push(number);
  }
  return [...new Set(numbers)];
}

export function extractCitationMarkers(text) {
  return [...String(text).matchAll(/\[\s*\d+(?:\s*[,;，−–—-]\s*\d+)*\s*\]/g)]
    .map((match) => ({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      numbers: parseCitationNumbers(match[0]),
    }))
    .filter((marker) => marker.numbers.length);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 10;
}

/** Form separate line fragments across the gutter, preserving column reading order. */
export function pageLines(page) {
  const rows = [];
  for (const item of [...page.items]
    .filter((item) => item.str?.trim())
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    const height = Math.abs(item.height) || 10;
    let row = rows.find(
      (row) => Math.abs(row.y - item.y) < Math.min(row.height, height) * 0.35,
    );
    if (!row) rows.push((row = { y: item.y, height, items: [] }));
    row.items.push(item);
  }
  const lines = [];
  for (const row of rows) {
    let group = [];
    const flush = () => {
      if (!group.length) return;
      lines.push({
        text: group
          .map((item) => item.str.trim())
          .join(" ")
          .replace(/\s+/g, " "),
        x: group[0].x,
        y: row.y,
        height: median(group.map((item) => Math.abs(item.height) || 10)),
        page: page.page,
        width: page.width,
        fontName: group[0].fontName || "",
      });
      group = [];
    };
    for (const item of row.items.sort((a, b) => a.x - b.x)) {
      const previous = group.at(-1);
      if (
        previous &&
        item.x - (previous.x + (previous.width || 0)) >
          Math.max(20, page.width * 0.035)
      )
        flush();
      group.push(item);
    }
    flush();
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

function columnOrder(lines) {
  if (!lines.length) return [];
  const width = lines[0].width;
  const right = lines.filter((line) => line.x > width * 0.48);
  // Requiring several fragments avoids treating a right-aligned page number as a column.
  if (right.length < 3)
    return [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  return [...lines].sort(
    (a, b) =>
      Number(a.x > width * 0.48) - Number(b.x > width * 0.48) ||
      a.y - b.y ||
      a.x - b.x,
  );
}

function referenceStart(text) {
  const match = text.match(
    /^\s*(?:\[(\d{1,4})\]|(\d{1,4})[.)]|(\d{1,4})\s+(?=[A-Z\p{Script=Han}]))\s*(.+)$/u,
  );
  return match
    ? { number: Number(match[1] || match[2] || match[3]), text: match[4] }
    : null;
}

// Find a sentence boundary without splitting organism names, author initials,
// or common abbreviations. The original reference is always retained in raw.
function sentenceEnd(text, { authors = false } = {}) {
  for (const match of text.matchAll(/[.!?](?=\s+\S)/g)) {
    const before = text.slice(0, match.index);
    const word = before.match(/([\p{L}]+)$/u)?.[1] || "";
    const after = text.slice(match.index + 1).trimStart();
    if (match[0] === ".") {
      if (authors && /\bet al$/i.test(before)) return match.index;
      if (
        authors &&
        /[\p{Lu}][\p{Ll}'-]+,?\s+[\p{Lu}]$/u.test(before) &&
        /^(?:\p{Lu}\p{Ll}|\p{Lu}\.\s+\p{Ll})/u.test(after)
      )
        return match.index;
      if (/^(?:e\.g|i\.e)$/i.test(before.split(/\s/).at(-1))) continue;
      if (
        word.length === 1 ||
        /^(?:al|vs|sp|spp|subsp|cf|fig|no|dr|prof)$/i.test(word)
      )
        continue;
      // A lowercase continuation normally belongs to the same sentence.
      if (/^\p{Ll}/u.test(after)) continue;
    }
    return match.index;
  }
  return -1;
}

export function parseReference(entry) {
  const raw = entry.parts
    .join(" ")
    .replace(/([a-z])-\s+([a-z])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  // Rejoin only a DOI continuation after a PDF line break, never ordinary
  // prose following a DOI. Numeric suffixes and a split after '/' are common.
  const doiText = entry.parts
    .join("\n")
    .replace(
      /(10\.\d{4,9}\/[^\s<>"…]*)\s*\n\s*([\w./;():-]+)/gi,
      (whole, prefix, suffix) =>
        /[/.\-]$/.test(prefix) || /^\d/.test(suffix) ? prefix + suffix : whole,
    );
  let doi =
    doiText.match(/\b10\.\d{4,9}\/[^\s<>"…]+/i)?.[0].replace(/[.,;]+$/, "") ||
    "";
  // A final unmatched ')' closes a surrounding citation, not the DOI.
  while (
    doi.endsWith(")") &&
    (doi.match(/\)/g)?.length || 0) > (doi.match(/\(/g)?.length || 0)
  )
    doi = doi.slice(0, -1);
  const year = raw.match(/\b(?:19|20)\d{2}[a-z]?\b/)?.[0] || "";
  // A conservative bibliographic heuristic; raw remains the authoritative source.
  const clean = doiText
    .replace(/(?:https?:\/\/\S+|doi\s*:\s*\S+|\b10\.\d{4,9}\/\S+)/gi, "")
    .replace(/([a-z])-\s+([a-z])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  const yearPosition = year ? clean.indexOf(year) : -1;
  let authors = "",
    title = "",
    journal = "";
  const beforeYear = clean.slice(0, yearPosition);
  // Position alone confuses a short Vancouver title with author-year style.
  const authorYear =
    yearPosition >= 0 &&
    (/\(\s*$/.test(beforeYear) ||
      (yearPosition < clean.length * 0.55 &&
        sentenceEnd(beforeYear, { authors: true }) < 0));
  if (authorYear) {
    authors = clean.slice(0, yearPosition).replace(/[\s(. ,;]+$/, "");
    const remainder = clean
      .slice(yearPosition + year.length)
      .replace(/^[\s).,;:]+/, "");
    const end = sentenceEnd(remainder);
    title = end >= 0 ? remainder.slice(0, end) : remainder;
    journal =
      end >= 0
        ? remainder
            .slice(end + 1)
            .trim()
            .replace(/[.]+$/, "")
        : "";
  }
  // Vancouver style puts the year after the title/journal. Initials are left intact.
  if (!title) {
    const authorEnd = sentenceEnd(clean, { authors: true });
    if (authorEnd >= 0) {
      authors = clean.slice(0, authorEnd);
      const remainder = clean.slice(authorEnd + 1).trim();
      const end = sentenceEnd(remainder);
      title = end >= 0 ? remainder.slice(0, end) : remainder;
      journal = end >= 0 ? remainder.slice(end + 1).trim() : "";
      if (year && journal.includes(year))
        journal = journal.slice(0, journal.indexOf(year)).trim();
      journal = journal.replace(/[\s.,;:(]+$/, "");
    }
  }
  return {
    number: entry.number,
    raw,
    title: title.replace(/[.]+$/, ""),
    authors,
    year,
    journal,
    doi,
    page: entry.page,
    y: entry.y,
  };
}

const normalizedHeading = (text) =>
  String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Remove first-page article titles from native, inferred, or cached AI outlines. */
export function filterOutline(outline, pages, documentTitle = "") {
  const first = pages[0];
  if (!first) return outline;
  const lines = pageLines(first);
  const structural = (text) => SECTION_HEADING.test(String(text).trim());
  const boundary =
    lines.find((line) => structural(line.text))?.y ?? first.height * 0.5;
  const bodyHeight = median(
    pages
      .flatMap((page) => page.items)
      .filter((item) => item.str?.length > 45)
      .map((item) => Math.abs(item.height) || 10),
  );
  const early = lines.filter(
    (line) => line.y < boundary && !structural(line.text),
  );
  const largest = Math.max(0, ...early.map((line) => line.height));
  const titleLines = early.filter(
    (line) =>
      line.height >= bodyHeight * 1.2 &&
      line.height >= largest * 0.85 &&
      line.text.length >= 8 &&
      !/^(?:original (?:research|article)|research article|review|article)$/i.test(
        line.text,
      ),
  );
  const candidates = [documentTitle];
  let group = [];
  const flush = () => {
    if (group.length) candidates.push(group.map((line) => line.text).join(" "));
    group = [];
  };
  for (const line of titleLines) {
    if (
      group.length &&
      line.y - group.at(-1).y > Math.max(line.height, group.at(-1).height) * 2.5
    )
      flush();
    group.push(line);
  }
  flush();
  const titles = candidates
    .map(normalizedHeading)
    .filter((title) => title.length >= 8);
  return outline.filter((heading) => {
    if (heading.page !== first.page || structural(heading.title)) return true;
    const text = normalizedHeading(heading.title);
    if (!text || (heading.y > boundary && heading.y > 0)) return true;
    return !titles.some(
      (title) =>
        title === text ||
        (text.length >= 8 &&
          text.split(" ").length >= 2 &&
          ` ${title} `.includes(` ${text} `)),
    );
  });
}

export function analyzeDocument(pages, nativeOutline = []) {
  const allPages = pages.map((page) => ({ ...page, lines: pageLines(page) }));
  const allLines = allPages.flatMap((page) => page.lines);
  const bodyHeight = median(
    allLines.filter((line) => line.text.length > 45).map((line) => line.height),
  );
  const inferredOutline = allLines
    .filter(
      (line) =>
        line.text.length <= 120 &&
        !(/^\d+[.)]?\s/.test(line.text) && /[.;]$/.test(line.text)) &&
        (SECTION_HEADING.test(line.text) ||
          (line.height > bodyHeight * 1.2 &&
            line.text.length < 90 &&
            !/[.!?]$/.test(line.text) &&
            !/^\d+$/.test(line.text))),
    )
    .map((line) => ({
      title: line.text,
      page: line.page,
      y: line.y,
      level: Math.min(
        4,
        (line.text.match(/^\d+(\.\d+)*/)?.[0].match(/\./g)?.length || 0) + 1,
      ),
      source: "heuristic",
    }));
  const outline = filterOutline(
    nativeOutline.length ? nativeOutline : inferredOutline,
    pages,
  );
  const references = [];
  let started = false,
    current = null,
    stopped = false;
  const commit = () => {
    if (current) references.push(parseReference(current));
    current = null;
  };
  for (const page of allPages) {
    let lines = page.lines;
    const heading = lines.find((line) => REFERENCE_HEADING.test(line.text));
    if (!started && heading) {
      started = true;
      // A reference section may begin halfway down the left column and continue
      // from the top of the right column on the very same page.
      const continuationOnRight =
        heading.x < page.width * 0.48 &&
        lines.some(
          (line) =>
            line.x > page.width * 0.48 &&
            line.y < heading.y &&
            referenceStart(line.text),
        );
      lines = lines.filter(
        (line) =>
          line.y > heading.y + 2 ||
          (continuationOnRight && line.x > page.width * 0.48),
      );
    }
    if (!started || stopped) continue;
    for (const line of columnOrder(lines)) {
      if (
        REFERENCE_HEADING.test(line.text) ||
        /^\d+$/.test(line.text) ||
        line.y > page.height - 22 ||
        line.y < 15
      )
        continue;
      if (
        /^(?:appendix|supplementary (?:information|material)|supporting information)\b/i.test(
          line.text,
        )
      ) {
        commit();
        stopped = true;
        break;
      }
      const start = referenceStart(line.text);
      if (start) {
        commit();
        current = { ...start, page: line.page, y: line.y, parts: [start.text] };
      } else if (current) current.parts.push(line.text);
    }
  }
  commit();
  const uniqueReferences = [
    ...new Map(
      references.map((reference) => [reference.number, reference]),
    ).values(),
  ];
  const citations = allPages.flatMap((page) =>
    page.lines.flatMap((line) =>
      extractCitationMarkers(line.text).map((marker) => ({
        ...marker,
        page: line.page,
        x: line.x,
        y: line.y,
      })),
    ),
  );
  return { outline, references: uniqueReferences, citations };
}

function tokens(value) {
  const text = String(value || "").toLowerCase();
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "into",
    "study",
    "research",
    "using",
    "effects",
    "role",
  ]);
  const latin = (text.match(/[a-z][a-z0-9+-]{2,}/g) || []).filter(
    (word) => !stop.has(word),
  );
  const chinese = (text.match(/[\p{Script=Han}]{2,}/gu) || []).flatMap((word) =>
    Array.from({ length: word.length - 1 }, (_, index) =>
      word.slice(index, index + 2),
    ),
  );
  return [...new Set([...latin, ...chinese])];
}

const textList = (value) =>
  Array.isArray(value) ? value.join(" ") : String(value || "");

/** Title-based lexical ranking; never implies the abstract or full text was read. */
export function recommendReferences(
  references,
  profile = {},
  currentDocument = {},
) {
  const weighted = new Map();
  const add = (text, weight) =>
    tokens(text).forEach((token) =>
      weighted.set(token, (weighted.get(token) || 0) + weight),
    );
  add(profile.direction, 4);
  add(textList(profile.interests), 4);
  const history = [...(profile.history || [])]
    .sort((a, b) =>
      String(b.readAt || "").localeCompare(String(a.readAt || "")),
    )
    .slice(0, 20);
  history.forEach((entry, index) => {
    const weight = 3 / (1 + index * 0.2);
    add(entry.title, weight);
    add(textList(entry.topics), weight);
    add(textList(entry.annotations), weight);
  });
  if (!history.length) {
    add(currentDocument.title, 1);
    add(textList(currentDocument.topics), 1);
  }
  const seen = new Set();
  return references
    .filter((reference) => {
      const key =
        reference.doi?.toLowerCase() ||
        (reference.title || reference.raw || String(reference.number))
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]/gu, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((reference) => {
      const matches = tokens(reference.title || reference.raw).filter((token) =>
        weighted.has(token),
      );
      const score = matches.reduce(
        (sum, token) => sum + weighted.get(token),
        0,
      );
      return {
        ...reference,
        score,
        matchedTerms: matches,
        reason: matches.length
          ? `题名关键词与${history.length ? "研究方向及近期阅读" : "研究方向或当前论文"}相关：${matches.slice(0, 4).join("、")}。`
          : "信息不足，作为当前论文参考文献中的待探索条目。",
        evidence: reference.title ? "title-only" : "reference-text-only",
      };
    })
    .sort((a, b) => b.score - a.score || a.number - b.number)
    .slice(0, 3);
}
