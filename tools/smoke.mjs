import { _electron as electron } from "playwright";
import { createFixture } from "./fixture.mjs";
import { PDFDocument } from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve("test-results"),
  run = path.join(root, `run-${Date.now()}`);
await fs.mkdir(run, { recursive: true });
await fs.mkdir(path.join(run, "profile"), { recursive: true });
await fs.writeFile(path.join(run, "profile", "settings.json"), JSON.stringify({ onboardingComplete: true }));
const file = path.join(run, "reading-specimen.pdf");
await createFixture(file);
const app = await electron.launch({
  ...(process.env.READERD_EXECUTABLE
    ? { executablePath: process.env.READERD_EXECUTABLE, args: [] }
    : { args: ["."] }),
  env: { ...process.env, READERD_USER_DATA: path.join(run, "profile") },
  timeout: 60000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
      console.log("renderer:", message.text());
    }
  });
  await page.waitForFunction(() => !!window.readerdApp, { timeout: 30000 });
  const initialBounds = await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    area: screen.getPrimaryDisplay().workArea,
  }));
  if (initialBounds.area.height >= 680) {
    const previousGap =
      initialBounds.area.height -
      Math.max(600, Math.min(920, initialBounds.area.height - 80));
    const expectedGap = previousGap / 3;
    assert.ok(
      Math.abs(
        initialBounds.area.height - initialBounds.bounds.height - expectedGap,
      ) <= 4,
    );
    assert.ok(
      Math.abs(
        initialBounds.bounds.y - initialBounds.area.y - expectedGap / 2,
      ) <= 2,
    );
  }
  const home = await page.evaluate(() => {
    const reader = document.getElementById("reader"),
      left = document.getElementById("outline-panel"),
      right = document.getElementById("recommend-panel");
    return {
      background: getComputedStyle(reader).backgroundColor,
      height: reader.clientHeight,
      viewport: innerHeight,
      left: left.offsetHeight,
      right: right.offsetHeight,
      scroll: reader.scrollHeight,
    };
  });
  assert.equal(home.background, "rgb(241, 242, 238)");
  assert.equal(home.height, home.viewport);
  assert.equal(home.scroll, home.height);
  for (const height of [home.left, home.right])
    assert.ok(height >= 220 && height < home.viewport / 2);
  const sizes = await page.evaluate(() => {
    const panel = document.getElementById("outline-panel"),
      list = document.getElementById("outline");
    const original = list.innerHTML;
    const small = panel.offsetHeight;
    list.replaceChildren(
      ...Array.from({ length: 100 }, (_, i) => {
        const row = document.createElement("p");
        row.textContent = "Chapter " + i;
        return row;
      }),
    );
    const large = panel.offsetHeight,
      overflow = panel.scrollHeight > panel.clientHeight;
    list.innerHTML = original;
    return {
      small,
      large,
      restored: panel.offsetHeight,
      overflow,
      viewport: innerHeight,
    };
  });
  assert.ok(sizes.large > sizes.small);
  assert.ok(sizes.large <= sizes.viewport);
  assert.ok(sizes.overflow);
  assert.equal(sizes.restored, sizes.small);
  await page.screenshot({ path: path.join(root, "welcome.png") });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
  await page.keyboard.press("Control+o");
  await page.waitForFunction(
    () => window.readerdApp.state.references.length === 4,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".textLayer span")?.getBoundingClientRect().width >
      0,
  );
  assert.equal(await page.locator(".page").count(), 3);
  const pageGaps = await page
    .locator(".page")
    .evaluateAll((pages) =>
      pages
        .slice(1)
        .map(
          (page, i) =>
            page.getBoundingClientRect().top -
            pages[i].getBoundingClientRect().bottom,
        ),
    );
  for (const gap of pageGaps)
    assert.ok(Math.abs(gap) < 0.1, `Unexpected PDF page gap: ${gap}`);
  assert.equal(
    await page
      .locator("#reader")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgba(0, 0, 0, 0)",
  );
  assert.ok((await page.locator("#outline a").count()) >= 4);
  assert.equal(await page.locator("button").count(), 0);
  const transparency = await page.evaluate(() => ({
    root: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    left: getComputedStyle(document.getElementById("outline-panel"))
      .backgroundColor,
    right: getComputedStyle(document.getElementById("recommend-panel"))
      .backgroundColor,
    blur: getComputedStyle(document.getElementById("outline-panel"))
      .backdropFilter,
    pageTop: document.querySelector(".page").getBoundingClientRect().top,
    outlineWidth: document.getElementById("outline-panel").clientWidth,
  }));
  for (const key of ["root", "body"])
    assert.equal(transparency[key], "rgba(0, 0, 0, 0)");
  for (const key of ["left", "right"])
    assert.equal(transparency[key], "rgb(241, 242, 238)");
  assert.equal(transparency.blur, "none");
  assert.equal(transparency.pageTop, 0);
  assert.ok(transparency.outlineWidth >= 300);
  const checkColumns = async () => {
    const layout = await page.evaluate(() => {
      const left = document
        .getElementById("outline-panel")
        .getBoundingClientRect();
      const right = document
        .getElementById("recommend-panel")
        .getBoundingClientRect();
      const reader = document.getElementById("reader").getBoundingClientRect();
      return {
        gapLeft: reader.left - left.right,
        gapRight: right.left - reader.right,
        topLeft: left.top,
        topRight: right.top,
        topReader: reader.top,
        radius: getComputedStyle(document.getElementById("outline-panel"))
          .borderTopLeftRadius,
        overflow: getComputedStyle(document.getElementById("reader")).overflowX,
      };
    });
    assert.ok(layout.gapLeft >= 15 && layout.gapRight >= 15);
    assert.equal(layout.topLeft, layout.topReader);
    assert.equal(layout.topRight, layout.topReader);
    assert.equal(layout.radius, "16px");
    assert.equal(layout.overflow, "auto");
  };
  await checkColumns();
  const wheelStart = await page.evaluate(() => ({
    scale: window.readerdApp.state.scale,
    font: getComputedStyle(document.getElementById("outline-panel")).fontSize,
  }));
  const readerBox = await page.locator("#reader").boundingBox();
  await page.mouse.move(
    readerBox.x + readerBox.width / 2,
    readerBox.y + readerBox.height / 3,
  );
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.waitForFunction(
    (scale) => window.readerdApp.state.scale > scale,
    wheelStart.scale,
  );
  await page.waitForFunction(() =>
    window.readerdApp.state.views.every((v) => !v.task),
  );
  const wheelLarger = await page.evaluate(() => window.readerdApp.state.scale);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 120);
  await page.keyboard.up("Control");
  await page.waitForFunction(
    (scale) => window.readerdApp.state.scale < scale,
    wheelLarger,
  );
  await page.waitForFunction(() =>
    window.readerdApp.state.views.every((v) => !v.task),
  );
  assert.equal(
    await page
      .locator("#outline-panel")
      .evaluate((el) => getComputedStyle(el).fontSize),
    wheelStart.font,
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
    1,
  );
  await page.keyboard.press("Control+0");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Control++");
  await page.waitForFunction(
    () =>
      window.readerdApp.state.views.every((v) => !v.task) &&
      !!document.querySelector(".page:first-child .textLayer span"),
  );
  const panBox = await page.locator("#reader").boundingBox();
  const panBefore = await page
    .locator("#reader")
    .evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  await page.mouse.move(panBox.x + 25, 100);
  await page.mouse.down();
  await page.mouse.move(panBox.x - 50, 30, { steps: 5 });
  await page.mouse.up();
  const panAfter = await page
    .locator("#reader")
    .evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  assert.ok(panAfter.x > panBefore.x + 30 && panAfter.y > panBefore.y + 30);
  const panText = await page.evaluate(() => {
    const bounds = document.getElementById("reader").getBoundingClientRect();
    const span = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.top > 70 &&
        r.bottom < bounds.bottom - 80 &&
        r.left > bounds.left &&
        r.right < bounds.right &&
        r.width > 60
      );
    });
    const r = span.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(panText.x, panText.y);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.move(panText.x - 45, panText.y - 35, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  const panCtrl = await page.locator("#reader").evaluate((el) => ({
    x: el.scrollLeft,
    y: el.scrollTop,
    panning: el.classList.contains("is-panning"),
  }));
  assert.ok(panCtrl.x > panAfter.x + 20 && panCtrl.y > panAfter.y + 15);
  assert.equal(panCtrl.panning, false);
  await checkColumns();
  const originalSize = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getSize(),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(920, 900),
  );
  await page.waitForFunction(() => innerWidth <= 1000);
  await checkColumns();
  await page.screenshot({ path: path.join(root, "layout-narrow.png") });
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setSize(...size),
    originalSize,
  );
  await page.waitForFunction(() => innerWidth > 1000);
  await page.keyboard.press("Control+0");
  assert.doesNotMatch(
    await page.locator("#outline").innerText(),
    /Microbial metabolism and|the next question/,
  );
  // Electron's getter deliberately omits alpha; inspect the captured surface too.
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor(),
    ),
    "#000000",
  );
  assert.equal(
    await app.evaluate(
      async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage()).toBitmap()[3],
    ),
    0,
  );
  const cite = await page.evaluate(() => {
    const span = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((s) => s.textContent.includes("[1, 2-4]"));
    const start = span.textContent.indexOf("["),
      range = document.createRange();
    range.setStart(span.firstChild, start);
    range.setEnd(span.firstChild, start + 8);
    const r = range.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(cite.x, cite.y);
  await page.waitForFunction(
    () =>
      !document.getElementById("citation-card").hidden &&
      document.querySelectorAll("#citation-card .reference").length === 4,
  );
  assert.ok(
    !(await page.locator("#citation-card").innerText()).includes("10.1000"),
  );
  assert.doesNotMatch(
    await page.locator("#citation-card").innerText(),
    /查看原文条目/,
  );
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      globalThis.readerdOpenedLink = url;
    };
  });
  await page.locator("#citation-card .reference a").first().click();
  await page.waitForFunction(
    () =>
      document.querySelector("#citation-card .reference a")?.dataset.doi ===
      "10.1000/test1",
  );
  assert.equal(
    await app.evaluate(() => globalThis.readerdOpenedLink),
    "https://doi.org/10.1000/test1",
  );
  await app.evaluate(({ net }) => {
    net.fetch = async () =>
      new Response(
        JSON.stringify({
          message: {
            items: [
              {
                DOI: "10.1234/resolved",
                title: ["Nicotinamide metabolism in the microbiome"],
                author: [{ family: "Smith" }],
                published: { "date-parts": [[2024]] },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
  });
  await page.evaluate(() => {
    window.readerdApp.state.references[0].doi = "";
    document
      .querySelector("#citation-card .reference a")
      .removeAttribute("data-doi");
  });
  await page.locator("#citation-card .reference a").first().click();
  await page.waitForFunction(
    () =>
      document.querySelector("#citation-card .reference a")?.dataset.doi ===
      "10.1234/resolved",
  );
  assert.equal(
    await app.evaluate(() => globalThis.readerdOpenedLink),
    "https://doi.org/10.1234/resolved",
  );
  await page.screenshot({ path: path.join(root, "citations.png") });
  await page.mouse.move(20, 20);
  const word = await page.evaluate(() => {
    const span = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((s) => s.textContent.includes("Microbial metabolism connects"));
    const r = document.createRange();
    r.setStart(span.firstChild, 10);
    r.setEnd(span.firstChild, 20);
    const box = r.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.locator(".page").first().dispatchEvent("pointerdown", {
    button: 4,
    clientX: word.x,
    clientY: word.y,
  });
  await page.waitForFunction(
    () =>
      window.readerdApp.state.settings.vocabulary?.metabolism?.state ===
      "known",
  );
  await page.locator(".page").first().dispatchEvent("pointerdown", {
    button: 3,
    clientX: word.x,
    clientY: word.y,
  });
  await page.waitForFunction(
    () =>
      window.readerdApp.state.settings.vocabulary?.metabolism?.state ===
      "unknown",
  );
  const rect = await page.evaluate(() => {
    const span = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((s) => s.textContent.includes("Microbial metabolism connects"));
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const r = range.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  assert.ok(rect.width > 100);
  await page.keyboard.press("w");
  await page.waitForFunction(
    () => window.readerdApp.state.annotations.length === 1,
  );
  await page.evaluate(() => {
    const span = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((s) => s.textContent.includes("A quiet reading environment"));
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press("s");
  await page.waitForFunction(() =>
    window.readerdApp.state.annotations.some((a) => a.type === "underline"),
  );
  await page.locator(".annotation.underline").first().hover();
  await page.keyboard.press("d");
  await page.waitForFunction(
    () => window.readerdApp.state.annotations.length === 1,
  );
  await page.keyboard.press("Control+s");
  await page.waitForFunction(
    () =>
      window.readerdApp.state.savedRevision ===
      window.readerdApp.state.revision,
  );
  await page.evaluate(() => {
    const span = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((s) => s.textContent.includes("following text"));
    const end = [
      ...document.querySelectorAll(".page:first-child .textLayer span"),
    ].find((s) => s.textContent.includes("Study pathways"));
    const range = document.createRange();
    range.setStart(span.firstChild, 0);
    range.setEnd(end.firstChild, end.firstChild.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press("a");
  await page.locator("#note-text").fill("中文批注：这条证据需要核实样本条件。");
  await page.keyboard.press("Control+Enter");
  const checkNoteAnchor = async () => {
    const position = await page.evaluate(() => {
      const span = [
        ...document.querySelectorAll(".page:first-child .textLayer span"),
      ].find((s) => s.textContent.includes("Study pathways"));
      const r = document.createRange();
      r.setStart(span.firstChild, span.firstChild.length - 1);
      r.setEnd(span.firstChild, span.firstChild.length);
      const end = r.getBoundingClientRect(),
        dot = document
          .querySelector(".annotation.note")
          .getBoundingClientRect();
      return {
        dx: dot.left + dot.width / 2 - end.right,
        dy: dot.top + dot.height / 2 - (end.top + end.height * 0.23),
        anchor: window.readerdApp.state.annotations.find(
          (a) => a.type === "note",
        ).anchor,
      };
    });
    assert.ok(position.anchor);
    assert.ok(
      Math.abs(position.dx - 2) < 1.5 && Math.abs(position.dy) < 1.5,
      JSON.stringify(position),
    );
  };
  await checkNoteAnchor();
  const noteScale = await page.evaluate(() => window.readerdApp.state.scale);
  await page.keyboard.press("Control++");
  await page.waitForFunction(
    (scale) => window.readerdApp.state.scale > scale,
    noteScale,
  );
  await page.waitForFunction(
    () =>
      window.readerdApp.state.views.every((v) => !v.task) &&
      [...document.querySelectorAll(".page:first-child .textLayer span")].some(
        (s) => s.textContent.includes("Study pathways"),
      ),
  );
  await checkNoteAnchor();
  await page.keyboard.press("Control+0");
  await page.waitForFunction(
    () =>
      window.readerdApp.state.views.every((v) => !v.task) &&
      [...document.querySelectorAll(".page:first-child .textLayer span")].some(
        (s) => s.textContent.includes("Study pathways"),
      ),
  );
  await checkNoteAnchor();
  await page.locator(".annotation.note").first().hover();
  await page.waitForFunction(
    () => !document.getElementById("note-card").hidden,
  );
  assert.equal(
    await page.locator("#note-card-content").innerText(),
    "中文批注：这条证据需要核实样本条件。",
  );
  assert.equal(
    await page
      .locator("#note-card")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(241, 242, 238)",
  );
  const noteMarker = await page
    .locator(".annotation.note")
    .first()
    .evaluate((el) => ({
      title: el.getAttribute("title"),
      border: getComputedStyle(el).borderBottomStyle,
      color: getComputedStyle(el, "::after").backgroundColor,
      size: getComputedStyle(el, "::after").width,
      shadow: getComputedStyle(el, "::after").boxShadow,
    }));
  assert.equal(noteMarker.title, null);
  assert.equal(noteMarker.border, "none");
  assert.equal(noteMarker.color, "rgb(179, 131, 73)");
  assert.equal(noteMarker.size, "4px");
  assert.equal(noteMarker.shadow, "none");
  await page.screenshot({ path: path.join(root, "note.png") });
  await page.mouse.move(20, 20);
  await page.waitForFunction(() => document.getElementById("note-card").hidden);
  await page.locator(".annotation.note").first().hover();
  await page.waitForFunction(
    () => !document.getElementById("note-card").hidden,
  );
  await page.locator(".annotation.note").first().dblclick();
  await page.waitForFunction(() => document.getElementById("note-dialog").open);
  assert.equal(
    await page.locator("#note-text").inputValue(),
    "中文批注：这条证据需要核实样本条件。",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.getElementById("note-dialog").open,
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+s");
  await page.waitForFunction(
    () =>
      window.readerdApp.state.savedRevision ===
      window.readerdApp.state.revision,
  );
  const saved = await PDFDocument.load(await fs.readFile(file));
  assert.equal(saved.getPageCount(), 4);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () => document.querySelectorAll(".recommendation").length === 3,
  );
  await page.keyboard.press("Control+,");
  await page.locator("#profile-identity").fill("研究生");
  await page.locator("#profile-direction").fill("微生物代谢与 NAD");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    () => !document.querySelector("#settings-dialog").open,
  );
  assert.equal(
    await page.evaluate(() => typeof window.readerdApp.state.settings),
    "object",
  );
  const profile = await fs.readFile(
    path.join(run, "profile", "reading-profile.md"),
    "utf8",
  );
  assert.ok(profile.includes("研究生"));
  assert.ok(profile.includes("reading-specimen.pdf"));
  await page.keyboard.press("Control+0");
  await page.screenshot({ path: path.join(root, "reading.png") });
  const previousDocument = await page.evaluate(
    () => window.readerdApp.state.documentId,
  );
  await page.keyboard.press("Control+o");
  await page.waitForFunction(
    (previousDocument) =>
      window.readerdApp.state.documentId !== previousDocument &&
      window.readerdApp.state.references.length === 4 &&
      window.readerdApp.state.annotations.length === 2,
    previousDocument,
  );
  assert.equal(await page.locator(".page").count(), 3);
  await checkNoteAnchor();
  await page.locator(".annotation.note").first().hover();
  await page.waitForFunction(
    () => !document.getElementById("note-card").hidden,
  );
  assert.equal(
    await page.locator("#note-card-content").innerText(),
    "中文批注：这条证据需要核实样本条件。",
  );
  await page.mouse.move(20, 20);
  await page.waitForFunction(() => document.getElementById("note-card").hidden);
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Close shortcut did not exit")),
      10000,
    );
    app.process().once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await page.keyboard.press("Control+q").catch((e) => {
    if (!e.message.includes("closed")) throw e;
  });
  await exited;
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        pages: 3,
        references: 4,
        recommendations: 3,
        annotations: 2,
        savedPages: 4,
        profile: "Chinese round-trip passed",
        screenshots: ["test-results/welcome.png", "test-results/reading.png"],
        run,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close().catch(() => {});
}
