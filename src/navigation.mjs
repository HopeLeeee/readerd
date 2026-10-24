import { pageLines } from "./analysis/index.js";

const normalize = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\s\d.()（）]+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** Resolve PDF destinations in PDF user space to scale-1 viewport coordinates.
 * A missing top coordinate is distinct from a real zero coordinate. */
export async function resolveOutlineDestination(pdf, input) {
  const dest =
    typeof input === "string" ? await pdf.getDestination(input) : input;
  if (!Array.isArray(dest) || dest[0] == null) return null;
  const page =
    typeof dest[0] === "number"
      ? dest[0] + 1
      : 1 + (await pdf.getPageIndex(dest[0]));
  if (!Number.isInteger(page) || page < 1 || page > pdf.numPages) return null;
  const proxy = await pdf.getPage(page),
    viewport = proxy.getViewport({ scale: 1 });
  const [left, bottom, right, top] = proxy.view;
  const kind = dest[1]?.name || dest[1];
  let x = left,
    y = top,
    hasPosition = false;
  if (kind === "XYZ") {
    x = Number.isFinite(dest[2]) ? dest[2] : left;
    if (Number.isFinite(dest[3])) {
      y = dest[3];
      hasPosition = true;
    }
  } else if (kind === "FitH" || kind === "FitBH") {
    if (Number.isFinite(dest[2])) {
      y = dest[2];
      hasPosition = true;
    }
  } else if (kind === "FitR" && dest.slice(2, 6).every(Number.isFinite)) {
    const corners = [
      [dest[2], dest[3]],
      [dest[4], dest[5]],
    ].map((p) => viewport.convertToViewportPoint(...p));
    return {
      page,
      x: Math.min(...corners.map((p) => p[0])),
      y: Math.max(0, Math.min(...corners.map((p) => p[1]))),
      hasPosition: true,
    };
  } else if (kind === "FitV" || kind === "FitBV") {
    x = Number.isFinite(dest[2]) ? dest[2] : left;
  }
  const point = viewport.convertToViewportPoint(x, y);
  return {
    page,
    x: Math.max(0, point[0]),
    y: hasPosition ? Math.max(0, point[1]) : 0,
    hasPosition,
  };
}

/** Locate a title on a page when a bookmark specifies only the page itself.
 * Consecutive lines allow headings split into several PDF text fragments. */
export function locateSectionHeading(title, page, preferredY = 0) {
  if (!page) return null;
  const target = normalize(title);
  if (target.length < 2) return null;
  const lines = pageLines(page),
    matches = [];
  for (let index = 0; index < lines.length; index++) {
    const first = lines[index];
    const columnLines = lines
      .slice(index)
      .filter((line) => Math.abs(line.x - first.x) <= 40);
    let text = "";
    for (let length = 0; length < 4 && length < columnLines.length; length++) {
      const line = columnLines[length],
        previous = columnLines[length - 1];
      if (
        length &&
        (Math.abs(line.x - first.x) > 40 ||
          line.y - previous.y > Math.max(line.height, previous.height) * 2.4)
      )
        break;
      text += normalize(line.text);
      if (text === target) {
        const y = Math.max(0, first.y - first.height);
        matches.push({
          x: first.x,
          y,
          height: first.height,
          distance: Math.abs(y - preferredY),
        });
      }
      if (text.length > target.length) break;
    }
  }
  matches.sort((a, b) => b.height - a.height || a.distance - b.distance);
  return matches[0] || null;
}

export function bindSectionPosition(item, pages) {
  // Some publishers encode a page-only bookmark as an explicit page-top XYZ.
  if (item.hasPosition && (item.y > 2 || item.source !== "bookmark"))
    return item;
  const match = locateSectionHeading(
    item.title,
    pages.find((p) => p.page === item.page),
    item.y || 0,
  );
  return match ? { ...item, x: match.x, y: match.y, hasPosition: true } : item;
}

/** Use scroll-relative rectangles rather than offsetTop's offset-parent chain. */
export function sectionScrollTop(reader, pageElement, y, scale, inset = 40) {
  return Math.max(
    0,
    reader.scrollTop +
      pageElement.getBoundingClientRect().top -
      reader.getBoundingClientRect().top +
      y * scale -
      inset,
  );
}
