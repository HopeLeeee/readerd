/** Drag the PDF without replacing ordinary text selection. */
export function bindPdfPan(reader, { isEnabled, onPanStart, onPanEnd } = {}) {
  const win = reader.ownerDocument.defaultView;
  const removers = [];
  let control = false;
  let drag = null;
  const enabled = () => !isEnabled || isEnabled();
  const blocked = (target) =>
    target?.closest?.(
      'input, textarea, select, button, a, dialog, [role="dialog"], [role="button"], [contenteditable]:not([contenteditable="false"]), .annotation, [data-annotation-id]',
    );
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  }
  function ready() {
    reader.classList.toggle(
      "pan-ready",
      Boolean((control && enabled()) || drag),
    );
  }
  function finish() {
    if (!drag) return;
    const { id } = drag;
    drag = null;
    if (reader.hasPointerCapture?.(id)) reader.releasePointerCapture(id);
    reader.classList.remove("is-panning");
    ready();
    onPanEnd?.();
  }
  listen(win, "keydown", (event) => {
    if (
      event.key !== "Control" ||
      event.metaKey ||
      event.altKey ||
      !enabled() ||
      blocked(event.target)
    )
      return;
    control = true;
    ready();
  });
  listen(win, "keyup", (event) => {
    if (event.key !== "Control") return;
    control = false;
    ready();
  });
  listen(win, "blur", () => {
    control = false;
    finish();
    ready();
  });
  listen(reader, "pointerdown", (event) => {
    if (
      drag ||
      !enabled() ||
      blocked(event.target) ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (event.pointerType && event.pointerType !== "mouse") return;
    const overflow =
      reader.scrollWidth > reader.clientWidth ||
      reader.scrollHeight > reader.clientHeight;
    const text = event.target?.closest?.(".textLayer span");
    const blank = !text;
    if (
      !overflow ||
      !(
        event.button === 1 ||
        (event.button === 0 && (event.ctrlKey || control || blank))
      )
    )
      return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: reader.scrollLeft,
      top: reader.scrollTop,
    };
    reader.setPointerCapture?.(event.pointerId);
    reader.classList.add("is-panning");
    ready();
    event.preventDefault();
    onPanStart?.();
  });
  listen(reader, "pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!enabled()) {
      finish();
      return;
    }
    reader.scrollLeft = drag.left + drag.x - event.clientX;
    reader.scrollTop = drag.top + drag.y - event.clientY;
    event.preventDefault();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    listen(reader, type, (event) => {
      if (drag && event.pointerId === drag.id) finish();
    });
  }
  listen(reader, "auxclick", (event) => {
    if (event.button === 1 && enabled() && !blocked(event.target))
      event.preventDefault();
  });
  return () => {
    control = false;
    finish();
    reader.classList.remove("pan-ready");
    for (const remove of removers) remove();
  };
}
