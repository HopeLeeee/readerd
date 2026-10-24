import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDoi,
  resolveReference,
  titleSimilarity,
} from "../electron/reference-links.mjs";

const title =
  "Intestinal transgene delivery with native E coli chassis allows persistent physiological changes";
const candidate = (doi = "10.1234/example") => ({
  DOI: doi,
  title: [title],
  author: [{ family: "Russell" }],
  published: { "date-parts": [[2022]] },
});
const fake = (items) => async (url, options) => {
  assert.equal(url.hostname, "api.crossref.org");
  assert.equal(url.searchParams.get("rows"), "5");
  assert.ok(options.signal instanceof AbortSignal);
  return { ok: true, json: async () => ({ message: { items } }) };
};

test("DOI normalization accepts prefixes, PDF line splits and balanced parentheses", () => {
  assert.equal(
    normalizeDoi("https://doi.org/10.1234/Abc\n.123."),
    "10.1234/abc.123",
  );
  assert.equal(normalizeDoi("doi: 10.1234/foo(2022)"), "10.1234/foo(2022)");
  assert.equal(normalizeDoi("10.1234/foo)"), "10.1234/foo");
  for (const value of [
    "https://example.com/a",
    "javascript:alert(1)",
    "10.1234/abc?next=evil",
    "10.12/foo",
    null,
  ])
    assert.equal(normalizeDoi(value), null);
});

test("supplied valid DOI resolves without making any request", async () => {
  assert.deepEqual(
    await resolveReference(
      { doi: "DOI:10.1234/TEST" },
      {
        fetchImpl: () => {
          throw Error("must not fetch");
        },
      },
    ),
    { doi: "10.1234/test", url: "https://doi.org/10.1234/test" },
  );
});

test("reference metadata resolves with strong title, author and year evidence", async () => {
  const ref = { title, authors: "Russell BJ, Brown SD", year: 2022 };
  const result = await resolveReference(ref, {
    fetchImpl: fake([candidate()]),
  });
  assert.equal(result.doi, "10.1234/example");
  assert.deepEqual(
    await resolveReference(ref, {
      fetchImpl: () => {
        throw Error("cache missing");
      },
    }),
    result,
  );
  assert.equal(
    titleSimilarity("A title: with punctuation", "A TITLE with punctuation."),
    1,
  );
});

test("resolver rejects wrong authors, wrong year, incomplete and unrelated titles", async () => {
  for (const ref of [
    { title, authors: "Brown SD", year: 2022 },
    { title, authors: "Russell BJ", year: 2010 },
    { title: "A completely unrelated study of a different bacterial species" },
    { title: title.slice(0, 50) },
  ])
    await assert.rejects(
      resolveReference(ref, { fetchImpl: fake([candidate()]) }),
      /未找到唯一/,
    );
});

test("generic short titles need author and year; ambiguous DOI matches never open", async () => {
  await assert.rejects(
    resolveReference(
      { title: "Gut microbiota" },
      { fetchImpl: fake([{ ...candidate(), title: ["Gut microbiota"] }]) },
    ),
    /未找到唯一/,
  );
  await assert.rejects(
    resolveReference(
      { title, authors: "Russell", year: 2023 },
      { fetchImpl: fake([candidate(), candidate("10.1234/other")]) },
    ),
    /未找到唯一/,
  );
});

test("network and malformed response failures produce useful messages", async () => {
  await assert.rejects(
    resolveReference(
      { title: title + " extended" },
      {
        fetchImpl: async () => {
          throw Error("offline");
        },
      },
    ),
    /网络/,
  );
  await assert.rejects(
    resolveReference(
      { title: title + " modified" },
      { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) },
    ),
    /查询失败/,
  );
  await assert.rejects(resolveReference({ title: "tiny" }), /不完整/);
});

test("an exact cited year distinguishes a final paper from its prior-year preprint", async () => {
  const final = {
    ...candidate("10.1234/final"),
    title: [title + " final-year"],
  };
  const preprint = {
    ...candidate("10.1234/preprint"),
    title: [title + " final-year"],
    published: { "date-parts": [[2021]] },
  };
  const result = await resolveReference(
    { title: title + " final-year", year: 2022, authors: "Russell" },
    { fetchImpl: fake([preprint, final]) },
  );
  assert.equal(result.doi, "10.1234/final");
});
