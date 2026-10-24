import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pdfPathsFromArguments } from "../electron/launch-files.mjs";
test("external reader filename preserves Chinese, spaces and parentheses", () => {
  const file = path.resolve("test-results", "文献 文件 (2026).pdf");
  assert.deepEqual(pdfPathsFromArguments(["readerd.exe", "--flag", file]), [
    file,
  ]);
  assert.deepEqual(pdfPathsFromArguments([`"${file}"`, file]), [file]);
});
test("relative paths and file URLs resolve to local PDFs without treating flags as files", () => {
  const cwd = path.resolve("test-results");
  const file = path.join(cwd, "Paper.PDF");
  assert.deepEqual(pdfPathsFromArguments(["Paper.PDF"], cwd), [file]);
  assert.deepEqual(
    pdfPathsFromArguments([pathToFileURL(file).href + "#page=2"]),
    [file],
  );
  assert.deepEqual(
    pdfPathsFromArguments([
      "--file=bad.pdf",
      "https://example.com/a.pdf",
      "https://example.com/a.pdf?file=1",
      "image.png",
      ".",
    ]),
    [],
  );
});
