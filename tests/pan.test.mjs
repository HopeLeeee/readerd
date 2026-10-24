import test from "node:test";
import assert from "node:assert/strict";
import { bindPdfPan } from "../src/pan.mjs";

function fixture() {
  const win = new EventTarget();
  const reader = new EventTarget();
  const classes = new Set();
  Object.assign(reader, {
    ownerDocument: { defaultView: win },
    clientWidth: 600,
    clientHeight: 600,
    scrollWidth: 1000,
    scrollHeight: 1800,
    scrollLeft: 200,
    scrollTop: 400,
    classList: {
      add: (x) => classes.add(x),
      remove: (x) => classes.delete(x),
      toggle: (x, value) => (value ? classes.add(x) : classes.delete(x)),
    },
    setPointerCapture(id) {
      this.captured = id;
    },
    hasPointerCapture(id) {
      return this.captured === id;
    },
    releasePointerCapture() {
      this.captured = null;
    },
  });
  let active = true,
    starts = 0,
    ends = 0;
  const cleanup = bindPdfPan(reader, {
    isEnabled: () => active,
    onPanStart: () => starts++,
    onPanEnd: () => ends++,
  });
  const target = (kind) => ({
    closest: (selector) => {
      if (kind === "text") return selector === ".textLayer span" ? {} : null;
      if (kind === "annotation" || kind === "editable")
        return selector === ".textLayer span" ? null : {};
      return null;
    },
  });
  function emit(surface, type, data = {}) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries({
          target: target("blank"),
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          clientX: 100,
          clientY: 100,
          ...data,
        }).map(([key, value]) => [key, { value }]),
      ),
    );
    surface.dispatchEvent(event);
    return event;
  }
  return {
    win,
    reader,
    classes,
    emit,
    target,
    cleanup,
    disable: () => {
      active = false;
    },
    stats: () => ({ starts, ends }),
  };
}

test("blank margin drag moves both axes and releases capture on cancellation", () => {
  const f = fixture();
  assert.equal(f.emit(f.reader, "pointerdown").defaultPrevented, true);
  f.emit(f.reader, "pointermove", { clientX: 40, clientY: 20 });
  assert.equal(f.reader.scrollLeft, 260);
  assert.equal(f.reader.scrollTop, 480);
  assert(f.classes.has("is-panning"));
  f.emit(f.reader, "pointercancel");
  assert.equal(f.reader.captured, null);
  assert(!f.classes.has("is-panning"));
  assert.deepEqual(f.stats(), { starts: 1, ends: 1 });
  f.cleanup();
});

test("ordinary text selection is preserved; Ctrl plus left button pans over text", () => {
  const f = fixture();
  assert.equal(
    f.emit(f.reader, "pointerdown", { target: f.target("text") })
      .defaultPrevented,
    false,
  );
  assert.equal(
    f.emit(f.win, "keydown", { key: "Control", ctrlKey: true })
      .defaultPrevented,
    false,
  );
  assert(f.classes.has("pan-ready"));
  assert.equal(
    f.emit(f.reader, "pointerdown", { target: f.target("text") })
      .defaultPrevented,
    true,
  );
  f.emit(f.win, "blur");
  assert(!f.classes.has("pan-ready"));
  assert(!f.classes.has("is-panning"));
  f.cleanup();
});

test("Ctrl pointer modifier alone enables text drag and leaves wheel zoom events untouched", () => {
  const f = fixture();
  assert.equal(
    f.emit(f.reader, "wheel", { ctrlKey: true }).defaultPrevented,
    false,
  );
  assert.equal(
    f.emit(f.reader, "pointerdown", { ctrlKey: true, target: f.target("text") })
      .defaultPrevented,
    true,
  );
  f.emit(f.reader, "pointermove", { clientX: 60, clientY: 50 });
  assert.equal(f.reader.scrollLeft, 240);
  assert.equal(f.reader.scrollTop, 450);
  f.emit(f.reader, "pointerup");
  assert(!f.classes.has("is-panning"));
  f.cleanup();
});

test("middle drag works over text, ignores annotations, and leaves side buttons alone", () => {
  const f = fixture();
  assert.equal(
    f.emit(f.reader, "pointerdown", { button: 3 }).defaultPrevented,
    false,
  );
  assert.equal(
    f.emit(f.reader, "pointerdown", {
      button: 1,
      target: f.target("annotation"),
    }).defaultPrevented,
    false,
  );
  assert.equal(
    f.emit(f.reader, "pointerdown", { button: 1, target: f.target("text") })
      .defaultPrevented,
    true,
  );
  f.emit(f.reader, "lostpointercapture");
  assert.deepEqual(f.stats(), { starts: 1, ends: 1 });
  f.cleanup();
});

test("Control does not intercept typing or activate with closed document; cleanup removes handlers", () => {
  const f = fixture();
  assert.equal(
    f.emit(f.win, "keydown", { key: "Control", target: f.target("editable") })
      .defaultPrevented,
    false,
  );
  f.disable();
  assert.equal(
    f.emit(f.win, "keydown", { key: "Control" }).defaultPrevented,
    false,
  );
  assert.equal(f.emit(f.reader, "pointerdown").defaultPrevented, false);
  f.cleanup();
  assert.equal(
    f.emit(f.reader, "pointerdown", { button: 1 }).defaultPrevented,
    false,
  );
});
