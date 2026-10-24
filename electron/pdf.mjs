import fs from "node:fs/promises";
import pdfLib from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { atomicWrite, normalizeAnnotations } from "./storage.mjs";
const { PDFDocument, PDFName, PDFString, PDFHexString, rgb, StandardFonts } =
  pdfLib;

async function noteFont(document) {
  for (const candidate of [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
    "C:/Windows/Fonts/arialuni.ttf",
  ]) {
    try {
      const bytes = await fs.readFile(candidate);
      document.registerFontkit({
        ...fontkit,
        create: (...args) => {
          const font = fontkit.create(...args);
          return font.fonts?.[0] ?? font;
        },
      });
      return await document.embedFont(bytes, { subset: true });
    } catch {
      /* Try the next locally available font. */
    }
  }
  return document.embedFont(StandardFonts.Helvetica);
}

export function wrapText(text, font, size, width) {
  const lines = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) {
        lines.push(line);
        line = "";
      }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

function link(document, page, rectangle, destinationPage, x, y) {
  const annotation = document.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: rectangle,
    Border: [0, 0, 0],
    Dest: [destinationPage.ref, PDFName.of("XYZ"), x, y, null],
  });
  page.node.addAnnot(document.context.register(annotation));
}

function noteMarker(page, note) {
  const rect = note.rects.at(-1);
  const y =
    note.coordinateSpace === "pdf"
      ? rect.y
      : page.getHeight() - rect.y - rect.height;
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const radius = 1.5;
  let [x, top] =
    rotation === 90
      ? [rect.x - 2, y + rect.height + 2]
      : rotation === 180
        ? [rect.x - 2, y - 2]
        : rotation === 270
          ? [rect.x + rect.width + 2, y - 2]
          : [rect.x + rect.width + 2, y + rect.height + 2];
  if (note.coordinateSpace === "pdf" && note.anchor) {
    x = note.anchor.x;
    top = note.anchor.y;
    if (rotation === 90) top += 1;
    else if (rotation === 180) x -= 1;
    else if (rotation === 270) top -= 1;
    else x += 1;
  }
  const crop = page.getCropBox();
  x = Math.max(crop.x + radius, Math.min(crop.x + crop.width - radius, x));
  top = Math.max(crop.y + radius, Math.min(crop.y + crop.height - radius, top));
  return {
    x,
    y: top,
    radius,
    rectangle: [x - radius, top - radius, x + radius, top + radius],
  };
}

function noteAppearance(document) {
  // A supplied appearance prevents PDF viewers from substituting a sticky-note icon.
  const r = 1.5,
    k = r * 0.5522847498;
  const appearance = document.context.flateStream(
    [
      "q",
      `${179 / 255} ${131 / 255} ${73 / 255} rg`,
      `${2 * r} ${r} m`,
      `${2 * r} ${r + k} ${r + k} ${2 * r} ${r} ${2 * r} c`,
      `${r - k} ${2 * r} 0 ${r + k} 0 ${r} c`,
      `0 ${r - k} ${r - k} 0 ${r} 0 c`,
      `${r + k} 0 ${2 * r} ${r - k} ${2 * r} ${r} c`,
      "f",
      "Q",
    ].join("\n"),
    {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: [0, 0, 3, 3],
      Resources: {},
    },
  );
  return document.context.register(appearance);
}

/** coordinateSpace:'pdf' uses actual PDF user-space points, bottom-left origin.
 * Legacy annotations without it retain their historical top-left origin.
 */
export async function renderAnnotations(source, annotations) {
  const document = await PDFDocument.load(source);
  const pages = document.getPages();
  const normalized = normalizeAnnotations(annotations, pages.length);
  const notes = [];
  for (const annotation of normalized) {
    const page = pages[annotation.page - 1];
    const { height } = page.getSize();
    if (annotation.type === "note") {
      notes.push(annotation);
      continue;
    }
    for (const rect of annotation.rects) {
      const y =
        annotation.coordinateSpace === "pdf"
          ? rect.y
          : height - rect.y - rect.height;
      if (annotation.type === "highlight")
        page.drawRectangle({
          x: rect.x,
          y,
          width: rect.width,
          height: rect.height,
          color: rgb(1, 0.83, 0.18),
          opacity: 0.28,
        });
      else {
        const rotation = ((page.getRotation().angle % 360) + 360) % 360;
        const edge =
          rotation === 90
            ? [
                { x: rect.x + rect.width - 1, y },
                { x: rect.x + rect.width - 1, y: y + rect.height },
              ]
            : rotation === 180
              ? [
                  { x: rect.x, y: y + rect.height - 1 },
                  { x: rect.x + rect.width, y: y + rect.height - 1 },
                ]
              : rotation === 270
                ? [
                    { x: rect.x + 1, y },
                    { x: rect.x + 1, y: y + rect.height },
                  ]
                : [
                    { x: rect.x, y: y + 1 },
                    { x: rect.x + rect.width, y: y + 1 },
                  ];
        page.drawLine({
          start: edge[0],
          end: edge[1],
          thickness: 1.1,
          color: rgb(0.8, 0.35, 0.12),
        });
      }
      const quad = [
        rect.x,
        y + rect.height,
        rect.x + rect.width,
        y + rect.height,
        rect.x,
        y,
        rect.x + rect.width,
        y,
      ];
      const object = document.context.obj({
        Type: "Annot",
        Subtype: annotation.type === "highlight" ? "Highlight" : "Underline",
        Rect: [rect.x, y, rect.x + rect.width, y + rect.height],
        QuadPoints: quad,
        C:
          annotation.type === "highlight" ? [1, 0.83, 0.18] : [0.8, 0.35, 0.12],
        CA: 0,
        NM: PDFString.of(annotation.id),
        Contents: PDFString.of(annotation.text),
        T: PDFString.of("readerd"),
      });
      page.node.addAnnot(document.context.register(object));
    }
  }
  if (notes.length) {
    const font = await noteFont(document);
    let appendix;
    let cursor = 0;
    const newPage = () => {
      appendix = document.addPage([595.28, 841.89]);
      cursor = 788;
      appendix.drawText("readerd annotations", {
        x: 42,
        y: cursor,
        font,
        size: 15,
        color: rgb(0.2, 0.25, 0.3),
      });
      cursor -= 35;
    };
    newPage();
    for (let index = 0; index < notes.length; index++) {
      const note = notes[index];
      const sourcePage = pages[note.page - 1];
      const rect = note.rects[0];
      if (cursor < 125) newPage();
      const notePage = appendix;
      const noteY = cursor;
      const header = `[${index + 1}] Source page ${note.page}  (x=${Math.round(rect.x)}, y=${Math.round(rect.y)})`;
      appendix.drawText(header, {
        x: 42,
        y: cursor,
        size: 10,
        font,
        color: rgb(0.15, 0.35, 0.6),
      });
      const sourceTop =
        note.coordinateSpace === "pdf"
          ? rect.y + rect.height
          : sourcePage.getHeight() - rect.y;
      link(
        document,
        appendix,
        [42, cursor - 3, 550, cursor + 13],
        sourcePage,
        rect.x,
        sourceTop,
      );
      cursor -= 21;
      let lines;
      try {
        lines = wrapText(note.text, font, 11, 505);
      } catch {
        throw new Error(
          "缺少支持批注文字的字体，无法将文字完整写入 PDF。请安装中文字体。",
        );
      }
      for (const line of lines) {
        if (cursor < 55) newPage();
        appendix.drawText(line, {
          x: 46,
          y: cursor,
          size: 11,
          font,
          color: rgb(0.15, 0.15, 0.15),
        });
        cursor -= 17;
      }
      cursor -= 18;
      const dot = noteMarker(sourcePage, note);
      link(document, sourcePage, dot.rectangle, notePage, 42, noteY);
      const marker = document.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: dot.rectangle,
        Contents: PDFHexString.fromText(note.text),
        T: PDFString.of("readerd"),
        C: [179 / 255, 131 / 255, 73 / 255],
        F: 4,
        AP: { N: noteAppearance(document) },
      });
      // Unicode contents are encoded as UTF-16 by PDFHexString rather than a PDF name.
      sourcePage.node.addAnnot(document.context.register(marker));
    }
  }
  document.setProducer("readerd");
  return {
    bytes: await document.save(),
    annotations: normalized,
    originalPageCount: pages.length,
  };
}

export async function saveAnnotatedPdf(file, annotations) {
  const backup = `${file}.readerd-original.pdf`;
  try {
    await fs.copyFile(
      file,
      backup,
      (await import("node:fs")).constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const source = await fs.readFile(backup);
  const result = await renderAnnotations(source, annotations);
  await atomicWrite(file, result.bytes);
  await atomicWrite(
    `${file}.readerd-annotations.json`,
    JSON.stringify(
      {
        annotations: result.annotations,
        originalPageCount: result.originalPageCount,
      },
      null,
      2,
    ),
  );
  return { path: file, originalPageCount: result.originalPageCount, backup };
}
