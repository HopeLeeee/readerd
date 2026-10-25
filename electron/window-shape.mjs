/** Clip the native backdrop as well as the web content to rounded window corners. */
export function roundedWindowShape(width, height, radius = 20) {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  radius = Math.max(
    0,
    Math.min(Math.floor(radius), Math.floor(width / 2), Math.floor(height / 2)),
  );
  if (!radius) return [{ x: 0, y: 0, width, height }];
  const rectangles = [
    { x: 0, y: radius, width, height: height - radius * 2 },
  ].filter((rect) => rect.height > 0);
  for (let y = 0; y < radius; y++) {
    const inset = Math.ceil(
      radius - Math.sqrt(radius ** 2 - (radius - y - 0.5) ** 2),
    );
    rectangles.push(
      { x: inset, y, width: width - inset * 2, height: 1 },
      { x: inset, y: height - y - 1, width: width - inset * 2, height: 1 },
    );
  }
  return rectangles.filter((rect) => rect.width > 0);
}
