import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import pdfLib from "pdf-lib";
const { PDFDocument } = pdfLib;
import {
  normalizeAnnotations,
  validateEndpoint,
  mergeProfileAutomatic,
  DEFAULT_PROFILE,
} from "../electron/storage.mjs";
import { saveAnnotatedPdf } from "../electron/pdf.mjs";
import { renderAnnotations } from "../electron/pdf.mjs";

test("AI endpoint requires TLS except loopback and rejects embedded credentials", () => {
  assert.equal(
    validateEndpoint("http://localhost:1234/v1").hostname,
    "localhost",
  );
  assert.throws(() => validateEndpoint("http://example.com/v1"));
  assert.throws(() => validateEndpoint("https://name:password@example.com"));
});

test("PDF-space annotations preserve coordinates on rotated cropped source pages", async () => {
  const original = await PDFDocument.create();
  const page = original.addPage([500, 700]);
  page.setCropBox(20, 30, 400, 600);
  page.setRotation(pdfLib.degrees(90));
  const result = await renderAnnotations(await original.save(), [
    {
      id: "rotated",
      type: "highlight",
      page: 1,
      coordinateSpace: "pdf",
      rects: [{ x: 70, y: 120, width: 20, height: 90 }],
    },
  ]);
  const saved = await PDFDocument.load(result.bytes);
  const object = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
  const rect = object.get(pdfLib.PDFName.of("Rect"));
  assert.deepEqual(
    rect.asArray().map((number) => number.asNumber()),
    [70, 120, 90, 210],
  );
  assert.equal(result.annotations[0].coordinateSpace, "pdf");
});

test("automated reading history preserves manually written Chinese profile", () => {
  const original = DEFAULT_PROFILE.replace(
    "- 身份：",
    "- 身份：研究生",
  ).replace("- 研究方向：", "- 研究方向：NAD+ 与肠道菌群");
  const merged = mergeProfileAutomatic(
    original,
    "<!-- readerd:auto:start -->\n新文献\n<!-- readerd:auto:end -->",
  );
  assert.match(merged, /身份：研究生/);
  assert.match(merged, /NAD\+ 与肠道菌群/);
  assert.match(merged, /新文献/);
  assert.doesNotMatch(merged, /暂无记录/);
});

test("exported text notes use a brown dot at the final line end with Unicode contents and return links", async () => {
  for (const [rotation, expected] of [
    [0, [230.5, 450.5, 233.5, 453.5]],
    [90, [166.5, 450.5, 169.5, 453.5]],
    [180, [166.5, 408.5, 169.5, 411.5]],
    [270, [230.5, 408.5, 233.5, 411.5]],
  ]) {
    const original = await PDFDocument.create();
    const page = original.addPage([500, 700]);
    page.setCropBox(20, 30, 400, 600);
    page.setRotation(pdfLib.degrees(rotation));
    const contents = "批注保存在 PDF 中。";
    const result = await renderAnnotations(await original.save(), [
      {
        id: "note-last-line",
        type: "note",
        page: 1,
        coordinateSpace: "pdf",
        text: contents,
        rects: [
          { x: 60, y: 470, width: 220, height: 18 },
          { x: 170, y: 412, width: 60, height: 38 },
        ],
      },
    ]);
    const saved = await PDFDocument.load(result.bytes);
    const annotations = saved
      .getPage(0)
      .node.Annots()
      .asArray()
      .map((ref) => saved.context.lookup(ref));
    assert.equal(annotations.length, 2);
    const note = annotations.find(
      (object) =>
        object.get(pdfLib.PDFName.of("Subtype")).asString() === "/Text",
    );
    const sourceLink = annotations.find(
      (object) =>
        object.get(pdfLib.PDFName.of("Subtype")).asString() === "/Link",
    );
    const numbers = (object, key) =>
      object
        .get(pdfLib.PDFName.of(key))
        .asArray()
        .map((value) => value.asNumber());
    assert.deepEqual(numbers(note, "Rect"), expected);
    assert.deepEqual(numbers(sourceLink, "Rect"), expected);
    assert.deepEqual(numbers(note, "C"), [179 / 255, 131 / 255, 73 / 255]);
    assert.equal(
      note.get(pdfLib.PDFName.of("Contents")).decodeText(),
      contents,
    );
    const appearance = saved.context.lookup(
      note.lookup(pdfLib.PDFName.of("AP")).get(pdfLib.PDFName.of("N")),
    );
    assert.deepEqual(numbers(appearance.dict, "BBox"), [0, 0, 3, 3]);
    assert.equal(
      appearance.dict.get(pdfLib.PDFName.of("Subtype")).asString(),
      "/Form",
    );
    assert.equal(saved.getPageCount(), 2);
    assert.equal(saved.getPage(1).node.Annots().size(), 1);
    assert.equal(
      sourceLink.get(pdfLib.PDFName.of("Dest")).get(0).toString(),
      saved.getPage(1).ref.toString(),
    );
  }
});

test("precise character endpoint survives saving and controls the exported dot", async () => {
  const original = await PDFDocument.create();
  original.addPage([500, 700]);
  const annotation = {
    id: "endpoint",
    type: "note",
    page: 1,
    coordinateSpace: "pdf",
    anchor: { x: 240, y: 350 },
    rects: [{ x: 50, y: 500, width: 300, height: 80 }],
    text: "anchored note",
  };
  const result = await renderAnnotations(await original.save(), [annotation]);
  assert.deepEqual(result.annotations[0].anchor, annotation.anchor);
  const saved = await PDFDocument.load(result.bytes);
  const note = saved
    .getPage(0)
    .node.Annots()
    .asArray()
    .map((r) => saved.context.lookup(r))
    .find((a) => a.get(pdfLib.PDFName.of("Subtype")).asString() === "/Text");
  assert.deepEqual(
    note
      .get(pdfLib.PDFName.of("Rect"))
      .asArray()
      .map((n) => n.asNumber()),
    [239.5, 348.5, 242.5, 351.5],
  );
});
test("malformed coordinates and nonexistent source pages are rejected", () => {
  assert.throws(() =>
    normalizeAnnotations(
      [
        {
          type: "highlight",
          page: 2,
          rects: [{ x: 1, y: 1, width: 4, height: 5 }],
        },
      ],
      1,
    ),
  );
  assert.throws(() =>
    normalizeAnnotations(
      [
        {
          type: "note",
          page: 1,
          rects: [{ x: NaN, y: 1, width: 4, height: 5 }],
        },
      ],
      1,
    ),
  );
});

test("repeated saves rebuild from original, preserve backup, and link visible notes both ways", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "readerd-test-"));
  try {
    const file = path.join(temporary, "paper.pdf");
    const original = await PDFDocument.create();
    original
      .addPage([500, 700])
      .drawText("Original paper text", { x: 40, y: 600 });
    const originalBytes = await original.save();
    await fs.writeFile(file, originalBytes);
    const annotations = [
      {
        id: "h1",
        type: "highlight",
        page: 1,
        rects: [{ x: 40, y: 80, width: 150, height: 20 }],
      },
      {
        id: "n1",
        type: "note",
        page: 1,
        rects: [{ x: 40, y: 80, width: 150, height: 20 }],
        text: "A visible note with a return link.",
      },
    ];
    await saveAnnotatedPdf(file, annotations);
    const first = await PDFDocument.load(await fs.readFile(file));
    assert.equal(first.getPageCount(), 2);
    const firstAnnots = first.getPage(0).node.Annots().size();
    assert.ok(firstAnnots >= 3);
    assert.ok(first.getPage(1).node.Annots().size() >= 1);
    await saveAnnotatedPdf(file, annotations);
    const second = await PDFDocument.load(await fs.readFile(file));
    assert.equal(second.getPageCount(), 2);
    assert.equal(second.getPage(0).node.Annots().size(), firstAnnots);
    assert.deepEqual(
      await fs.readFile(`${file}.readerd-original.pdf`),
      Buffer.from(originalBytes),
    );
    await saveAnnotatedPdf(file, []);
    assert.equal(
      (await PDFDocument.load(await fs.readFile(file))).getPageCount(),
      1,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
