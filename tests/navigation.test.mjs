import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveOutlineDestination,
  locateSectionHeading,
  bindSectionPosition,
  sectionScrollTop,
} from "../src/navigation.mjs";
const page = {
  view: [20, 30, 620, 830],
  getViewport: () => ({ convertToViewportPoint: (x, y) => [x - 20, 830 - y] }),
};
const pdf = {
  numPages: 3,
  getDestination: async (name) =>
    name === "discussion" ? [{ num: 7 }, { name: "XYZ" }, 55, 240, null] : null,
  getPageIndex: async () => 1,
  getPage: async () => page,
};
test("native XYZ bookmarks retain exact chapter coordinates and numeric page zero", async () => {
  assert.deepEqual(
    await resolveOutlineDestination(pdf, [0, { name: "XYZ" }, 55, 240, null]),
    { page: 1, x: 35, y: 590, hasPosition: true },
  );
  assert.equal((await resolveOutlineDestination(pdf, "discussion")).page, 2);
  assert.equal(
    (await resolveOutlineDestination(pdf, [0, { name: "XYZ" }, null, 0, null]))
      .y,
    830,
  );
});
test("FitH, FitBH and FitR convert crop offsets rather than discarding top", async () => {
  for (const kind of ["FitH", "FitBH"])
    assert.equal(
      (await resolveOutlineDestination(pdf, [0, { name: kind }, 490])).y,
      340,
    );
  assert.equal(
    (
      await resolveOutlineDestination(pdf, [
        0,
        { name: "FitR" },
        55,
        240,
        300,
        490,
      ])
    ).y,
    340,
  );
  assert.equal(
    (await resolveOutlineDestination(pdf, [0, { name: "FitH" }, null]))
      .hasPosition,
    false,
  );
  assert.equal(await resolveOutlineDestination(pdf, null), null);
});
test("rotated viewport uses PDF.js conversion for chapter position", async () => {
  const rotated = {
    ...pdf,
    getPage: async () => ({
      ...page,
      getViewport: () => ({
        convertToViewportPoint: (x, y) => [y - 30, x - 20],
      }),
    }),
  };
  const dest = await resolveOutlineDestination(rotated, [
    0,
    { name: "XYZ" },
    55,
    240,
    null,
  ]);
  assert.equal(dest.y, 35);
  assert.equal(dest.x, 210);
});
const documentPage = {
  page: 2,
  width: 600,
  height: 800,
  items: [
    { str: "Methods", x: 50, y: 350, height: 16, width: 100 },
    {
      str: "Isolation, genetic manipulation",
      x: 50,
      y: 510,
      height: 14,
      width: 250,
    },
    {
      str: "and colonisation screening",
      x: 50,
      y: 528,
      height: 14,
      width: 250,
    },
  ],
};
test("page-only bookmarks locate exact headings including wrapped titles", () => {
  assert.equal(locateSectionHeading("Methods", documentPage).y, 334);
  assert.equal(
    locateSectionHeading(
      "2.3 Isolation, genetic manipulation and colonisation screening",
      documentPage,
    ).y,
    496,
  );
  assert.equal(
    bindSectionPosition(
      { title: "Methods", page: 2, y: 0, hasPosition: false },
      [documentPage],
    ).y,
    334,
  );
  assert.equal(
    bindSectionPosition(
      { title: "Methods", page: 2, y: 120, hasPosition: true },
      [documentPage],
    ).y,
    120,
  );
});
test("scroll target includes section offset at current zoom regardless of offset parent", () => {
  const reader = { scrollTop: 800, getBoundingClientRect: () => ({ top: 10 }) };
  const el = { offsetTop: 99999, getBoundingClientRect: () => ({ top: 230 }) };
  assert.equal(sectionScrollTop(reader, el, 334, 1.5), 1481);
});
test("wrapped heading matching stays in its column when the other column shares baselines", () => {
  const page = {
    ...documentPage,
    items: [
      ...documentPage.items,
      {
        str: "Unrelated text on right",
        x: 350,
        y: 510,
        width: 180,
        height: 10,
      },
      { str: "Another body line", x: 350, y: 528, width: 180, height: 10 },
    ],
  };
  assert.equal(
    locateSectionHeading(
      "Isolation, genetic manipulation and colonisation screening",
      page,
    ).y,
    496,
  );
});
test("publisher bookmarks encoded as page-top XYZ refine to the matching chapter", () => {
  assert.equal(
    bindSectionPosition(
      {
        title: "Methods",
        page: 2,
        y: 0,
        hasPosition: true,
        source: "bookmark",
      },
      [documentPage],
    ).y,
    334,
  );
});
