import test from "node:test";
import assert from "node:assert/strict";
import {
  parseReference,
  filterOutline,
  analyzeDocument,
} from "../src/analysis/index.js";

const reference = (...parts) =>
  parseReference({ number: 4, page: 9, y: 100, parts });

test("keeps the complete Vancouver E. coli title and separates authors and journal", () => {
  const result = reference(
    "Russell BJ, Brown SD, Siguenza N, et al. Intestinal transgene delivery with native E.",
    "coli chassis allows persistent physiological changes. Cell Host Microbe 2022;30:123–135.",
  );
  assert.equal(
    result.title,
    "Intestinal transgene delivery with native E. coli chassis allows persistent physiological changes",
  );
  assert.equal(result.authors, "Russell BJ, Brown SD, Siguenza N, et al");
  assert.equal(result.journal, "Cell Host Microbe");
  assert.equal(result.year, "2022");
});

test("retains organism abbreviations and initials inside titles and abbreviated journal names", () => {
  const result = reference(
    "Smith A. S. aureus and E. coli: evidence from J. Smith et al. in vitro. J. Biol. Chem. 2024;12:1–9.",
  );
  assert.equal(result.authors, "Smith A");
  assert.equal(
    result.title,
    "S. aureus and E. coli: evidence from J. Smith et al. in vitro",
  );
  assert.equal(result.journal, "J. Biol. Chem");
  assert.equal(result.year, "2024");
});

test("a short Vancouver citation is not mistaken for author-year style", () => {
  const result = reference("Doe B. Short title. Cell 2021;10:123.");
  assert.equal(result.title, "Short title");
  assert.equal(result.journal, "Cell");
  assert.equal(result.year, "2021");
});

test("preserves full author-year titles and rejoins a DOI wrapped across PDF lines", () => {
  const result = reference(
    "Smith A., Jones B. (2020). Persistence of E. coli and S. aureus in vivo. Nature Microbiology. https://doi.org/10.1016/j.chom.",
    "2020.01.001.",
  );
  assert.equal(result.authors, "Smith A., Jones B");
  assert.equal(result.title, "Persistence of E. coli and S. aureus in vivo");
  assert.equal(result.journal, "Nature Microbiology");
  assert.equal(result.doi, "10.1016/j.chom.2020.01.001");
});

test("extracts DOI punctuation conservatively and does not invent missing DOI values", () => {
  assert.equal(
    reference("Doe B. Topic. Cell 2021;10:123. (doi:10.1000/abc(12)).").doi,
    "10.1000/abc(12)",
  );
  assert.equal(reference("Doe B. Topic. Cell 2021;10:123.").doi, "");
  assert.equal(
    reference(
      "Doe B. Topic. Cell 2021;10:123. doi:10.1000/complete",
      "Available online",
    ).doi,
    "10.1000/complete",
  );
});

const item = (str, y, height = 10) => ({ str, x: 40, y, height, width: 500 });
const page = {
  page: 1,
  width: 600,
  height: 800,
  items: [
    item("Original research", 20, 12),
    item("A durably colonising engineered native symbiont", 50, 24),
    item("enables sustained intestinal delivery for metabolic", 80, 24),
    item("dysfunction and colitis", 110, 24),
    item("Abstract", 200, 14),
    item(
      "A sufficiently long paragraph describing the scientific observations.",
      230,
    ),
    item("Introduction", 300, 14),
    item(
      "Isolation, genetic manipulation and colonisation screening of native E. coli",
      360,
      14,
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      item(
        "Ordinary body text describing experimental methods and observations.",
        400 + i * 15,
      ),
    ),
  ],
};
const fullTitle = page.items
  .slice(1, 4)
  .map((item) => item.str)
  .join(" ");

test("filters large first-page title fragments while preserving abstract and section titles", () => {
  const result = analyzeDocument([page]);
  assert.equal(
    result.outline.some((heading) => fullTitle.includes(heading.title)),
    false,
  );
  assert.ok(result.outline.some((heading) => heading.title === "Abstract"));
  assert.ok(result.outline.some((heading) => heading.title === "Introduction"));
  assert.ok(
    result.outline.some((heading) => heading.title.startsWith("Isolation,")),
  );
});

test("filters full native bookmark and cached AI title even without a reliable y position", () => {
  const outline = [
    { title: fullTitle, page: 1, y: 0, level: 1, source: "native" },
    { title: page.items[2].str, page: 1, level: 1, source: "ai" },
    { title: "Abstract", page: 1, y: 200, level: 1 },
    { title: "Introduction", page: 1, y: 300, level: 1 },
    { title: page.items[7].str, page: 1, y: 360, level: 2 },
    { title: fullTitle, page: 2, y: 40, level: 2 },
  ];
  assert.deepEqual(filterOutline(outline, [page], fullTitle), outline.slice(2));
});

test("metadata title filtering does not delete real early structural headings", () => {
  const outline = [
    { title: "Title from metadata", page: 1, y: 0 },
    { title: "1 Background", page: 1, y: 20 },
    { title: "Study design", page: 1, y: 30 },
  ];
  const simple = {
    page: 1,
    width: 600,
    height: 800,
    items: [item("1 Background", 20, 14), item("Study design", 30, 14)],
  };
  assert.deepEqual(
    filterOutline(outline, [simple], "Title from metadata"),
    outline.slice(1),
  );
});
