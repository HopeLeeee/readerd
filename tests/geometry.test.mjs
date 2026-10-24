import test from "node:test";
import assert from "node:assert/strict";
import {
  viewportRectToPdf,
  pdfRectToViewport,
  viewportClientRectToPdf,
  noteMarkerPoint,
} from "../src/geometry.mjs";

const transforms = [
  {
    rotation: 0,
    transform: [2, 0, 0, -2, -40, 1260],
    width: 800,
    height: 1200,
  },
  { rotation: 90, transform: [0, 2, 2, 0, -60, -40], width: 1200, height: 800 },
  {
    rotation: 180,
    transform: [-2, 0, 0, 2, 840, -60],
    width: 800,
    height: 1200,
  },
  {
    rotation: 270,
    transform: [0, -2, -2, 0, 1260, 840],
    width: 1200,
    height: 800,
  },
];
for (const viewport of transforms) {
  test(`PDF selection roundtrip with ${viewport.rotation} degree rotation and crop offsets`, () => {
    const source = { x: 100, y: 200, width: 60, height: 20 };
    const displayed = pdfRectToViewport(source, viewport);
    assert.deepEqual(viewportRectToPdf(displayed, viewport), source);
    const page = {
      left: 150,
      top: -90,
      width: viewport.width / 2,
      height: viewport.height / 2,
    };
    assert.deepEqual(
      viewportClientRectToPdf(
        {
          left: page.left + displayed.x / 2,
          top: page.top + displayed.y / 2,
          width: displayed.width / 2,
          height: displayed.height / 2,
        },
        page,
        viewport,
      ),
      source,
    );
  });
}
test("cropped normal page has exact top-left translation, not MediaBox-relative Y", () => {
  assert.deepEqual(
    viewportRectToPdf({ x: 0, y: 0, width: 100, height: 40 }, transforms[0]),
    { x: 20, y: 610, width: 50, height: 20 },
  );
});
test("note markers use the saved character anchor instead of an oversized text rectangle", () => {
  const note = {
    coordinateSpace: "pdf",
    anchor: { x: 100, y: 450 },
    rects: [{ x: 1, y: 2, width: 300, height: 200 }],
  };
  assert.deepEqual(noteMarkerPoint(note, transforms[0]), { x: 160, y: 360 });
  assert.deepEqual(
    noteMarkerPoint(
      { rects: [{ x: 10, y: 20, width: 100, height: 30 }] },
      transforms[0],
    ),
    { x: 110, y: 26.9 },
  );
});
