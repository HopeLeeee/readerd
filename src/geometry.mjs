function transformPoint(point, transform) {
  const [a, b, c, d, e, f] = transform;
  return [a * point[0] + c * point[1] + e, b * point[0] + d * point[1] + f];
}
function inversePoint(point, transform) {
  const [a, b, c, d, e, f] = transform;
  const determinant = a * d - b * c;
  if (!determinant)
    throw new Error("PDF viewport transform is not invertible.");
  const x = point[0] - e,
    y = point[1] - f;
  return [(d * x - c * y) / determinant, (a * y - b * x) / determinant];
}
function bounds(rect, convert) {
  const points = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ].map(convert);
  const xs = points.map((point) => point[0]),
    ys = points.map((point) => point[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
/** PDF rectangles are real PDF user-space coordinates, origin bottom left.
 * Viewport rectangles are CSS pixels, origin top left, at viewport.scale.
 * No page height is required, including rotated and cropped pages.
 */
export function viewportRectToPdf(rect, viewport) {
  return bounds(rect, ([x, y]) =>
    viewport.convertToPdfPoint
      ? viewport.convertToPdfPoint(x, y)
      : inversePoint([x, y], viewport.transform),
  );
}
export function pdfRectToViewport(rect, viewport) {
  return bounds(rect, ([x, y]) =>
    viewport.convertToViewportPoint
      ? viewport.convertToViewportPoint(x, y)
      : transformPoint([x, y], viewport.transform),
  );
}
export function viewportClientRectToPdf(clientRect, pageRect, viewport) {
  // CSS can resize the canvas independently of viewport dimensions.
  const factorX = viewport.width / pageRect.width;
  const factorY = viewport.height / pageRect.height;
  return viewportRectToPdf(
    {
      x: (clientRect.left - pageRect.left) * factorX,
      y: (clientRect.top - pageRect.top) * factorY,
      width: clientRect.width * factorX,
      height: clientRect.height * factorY,
    },
    viewport,
  );
}
export const selectionClientRect = viewportClientRectToPdf;
export const viewportRectToPdfRect = viewportRectToPdf;
export const pdfRectToViewportRect = pdfRectToViewport;

/** Use the last selected visible character, not a span's oversized line box. */
export function selectionEndAnchor(range, textLayer, pageRect, viewport) {
  const document = textLayer.ownerDocument;
  const walker = document.createTreeWalker(textLayer, 4);
  let node,
    lastRect = null;
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node)) continue;
    let end =
      node === range.endContainer ? range.endOffset : node.nodeValue.length;
    while (
      end > 0 &&
      (/\s/.test(node.nodeValue[end - 1]) ||
        range.comparePoint(node, end - 1) !== 0)
    )
      end--;
    if (!end) continue;
    const character = document.createRange();
    character.setStart(node, end - 1);
    character.setEnd(node, end);
    const rect = character.getBoundingClientRect();
    if (rect.width > 0.1 && rect.height > 0.1) lastRect = rect;
  }
  if (!lastRect) return null;
  const x =
    ((lastRect.right - pageRect.left) * viewport.width) / pageRect.width;
  const y =
    ((lastRect.top + lastRect.height * 0.23 - pageRect.top) * viewport.height) /
    pageRect.height;
  const point = viewport.convertToPdfPoint
    ? viewport.convertToPdfPoint(x, y)
    : inversePoint([x, y], viewport.transform);
  return { x: point[0], y: point[1] };
}

export function noteMarkerPoint(annotation, viewport) {
  if (
    annotation.coordinateSpace === "pdf" &&
    Number.isFinite(annotation.anchor?.x) &&
    Number.isFinite(annotation.anchor?.y)
  ) {
    const point = viewport.convertToViewportPoint
      ? viewport.convertToViewportPoint(
          annotation.anchor.x,
          annotation.anchor.y,
        )
      : transformPoint(
          [annotation.anchor.x, annotation.anchor.y],
          viewport.transform,
        );
    return { x: point[0], y: point[1] };
  }
  const stored = annotation.rects.at(-1);
  const rect =
    annotation.coordinateSpace === "pdf"
      ? pdfRectToViewport(stored, viewport)
      : stored;
  return { x: rect.x + rect.width, y: rect.y + rect.height * 0.23 };
}
