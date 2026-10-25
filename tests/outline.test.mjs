import test from "node:test";
import assert from "node:assert/strict";
import {
  pageLines,
  headingCandidates,
  resolveOutlineEntries,
} from "../src/analysis/index.js";
import { bindSectionPosition } from "../src/navigation.mjs";

const item = (str, x, y, width, fontName = "Bold", height = 14) => ({
  str,
  x,
  y,
  width,
  fontName,
  height,
});
const title =
  "PncA inhibitor PCN disrupts gut microbiome homeostasis and E. coli survival";
function fixture() {
  return [
    {
      page: 2,
      width: 600,
      height: 800,
      items: [
        item("Results", 40, 40, 60),
        item("Pnc", 40, 80, 22),
        item("A", 62, 80, 8, "BoldItalic"),
        item(" inhibitor PCN disrupts gut microbiome", 70, 80, 240),
        item("homeostasis and ", 40, 98, 110),
        item("E. coli", 150, 98, 38, "BoldItalic"),
        item(" survival", 188, 98, 50),
        item(
          "A long ordinary body paragraph with scientific evidence and results.",
          40,
          130,
          250,
          "Roman",
          10,
        ),
        item(
          "Another long body paragraph describing experimental procedures.",
          40,
          144,
          250,
          "Roman",
          10,
        ),
        item("Discussion", 40, 190, 80),
      ],
    },
  ];
}

test("joins inline font fragments without splitting PncA or losing E. coli spacing", () => {
  const lines = pageLines(fixture()[0]);
  assert.equal(lines[1].text, "PncA inhibitor PCN disrupts gut microbiome");
  assert.equal(lines[2].text, "homeostasis and E. coli survival");
});

test("multiline headings become complete candidates without merging body or neighbouring sections", () => {
  const titles = headingCandidates(fixture()).map((line) => line.text);
  assert.ok(titles.includes(title));
  assert.ok(titles.includes("Results"));
  assert.ok(titles.includes("Discussion"));
  assert.equal(
    titles.filter((value) => value.includes("homeostasis")).length,
    1,
  );
});

test("repairs and deduplicates exact legacy AI font fragments and keeps the first-line jump position", () => {
  const entries = ["Pnc", "E. coli", "homeostasis and "].map((title) => ({
    title,
    page: 2,
    y: 98,
    level: 2,
    source: "AI",
  }));
  const resolved = resolveOutlineEntries(entries, fixture());
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].title, title);
  assert.equal(resolved[0].y, 80);
  assert.equal(bindSectionPosition(resolved[0], fixture()).y, 66);
});

test("validates complete AI titles while rejecting invented abbreviations, pages and truncation", () => {
  assert.equal(
    resolveOutlineEntries([{ title, page: 2 }], fixture())[0].title,
    title,
  );
  for (const entry of [
    { title: "PncA inhibitor", page: 2 },
    { title: "E. coli causes disease", page: 2 },
    { title, page: 3 },
  ])
    assert.deepEqual(resolveOutlineEntries([entry], fixture()), []);
});

test("heading continuation stays within the same column and page", () => {
  const pages = fixture();
  pages[0].items.push(
    item("Right column heading", 335, 80, 200),
    item("continuation", 335, 98, 100),
    item("Materials", 335, 190, 100),
  );
  pages.push({
    ...pages[0],
    page: 3,
    items: [item("New page heading", 40, 116, 150)],
  });
  const titles = headingCandidates(pages).map((line) => line.text);
  assert.ok(titles.includes(title));
  assert.ok(titles.includes("Right column heading continuation"));
  assert.ok(titles.includes("New page heading"));
});

test("adjacent short subsection labels remain distinct even with matching typography", () => {
  const pages = fixture();
  pages[0].items.push(
    item("Materials", 40, 240, 80),
    item("Cell lines", 40, 258, 80),
    item("Bacterial strains", 40, 276, 110),
  );
  const titles = headingCandidates(pages).map((line) => line.text);
  for (const title of ["Materials", "Cell lines", "Bacterial strains"])
    assert.ok(titles.includes(title));
});
