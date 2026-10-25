import * as pdfjs from "../node_modules/pdfjs-dist/build/pdf.mjs";
import {
  analyzeDocument,
  filterOutline,
  headingCandidates,
  resolveOutlineEntries,
  recommendReferences,
} from "./analysis/index.js";
import { loadDictionary, dictionaryGloss } from "./words/dictionary.mjs";
import { WordCompanion, loadLexicon } from "./words/companion.js";
import { parseProfile, updateProfile } from "./profile.mjs";
import { bindCitationHover } from "./citations.mjs";
import { bindPdfPan } from "./pan.mjs";
import {
  viewportClientRectToPdf,
  pdfRectToViewport,
  selectionEndAnchor,
  noteMarkerPoint,
} from "./geometry.mjs";
import {
  resolveOutlineDestination,
  bindSectionPosition,
  sectionScrollTop,
} from "./navigation.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).href;
const $ = (id) => document.getElementById(id),
  api = window.readerd;
const state = {
  pdf: null,
  path: null,
  name: "",
  pages: [],
  views: [],
  annotations: [],
  undo: [],
  redo: [],
  outline: [],
  references: [],
  scale: 1,
  settings: {},
  profile: {},
  read: false,
  revision: 0,
  savedRevision: 0,
};
let lexicon,
  dictionary,
  companion,
  observer,
  toastTimer,
  saveTimer,
  positionTimer,
  hoverTimer,
  prefetchTimer,
  session = 0,
  settingsData,
  profileData,
  saveChain = Promise.resolve();
let firstRun = false,
  setupBusy = false,
  finishSetup;
const setupReady = new Promise((resolve) => {
  finishSetup = resolve;
});
const aiEnabled = () =>
  state.settings.provider === "codex" ||
  !!(state.settings.endpoint && state.settings.model);
const shortcuts = [
  ["Ctrl + O", "打开 PDF"],
  ["W / S / A", "选中文字后：高亮 / 下划线 / 批注"],
  ["D", "删除鼠标下的批注"],
  ["Ctrl + Z / Ctrl + Shift + Z", "撤销 / 重做"],
  ["Ctrl + S", "保存批注到 PDF"],
  ["Ctrl + F", "搜索正文"],
  ["Ctrl + + / − / 0", "放大 / 缩小 / 适应宽度"],
  ["Ctrl + 滚轮", "向上放大 / 向下缩小 PDF"],
  ["Ctrl + 左键拖动 / 中键拖动", "平移 PDF；空白处也可直接左键拖动"],
  ["Ctrl + Enter", "标记已读，生成三条推荐"],
  ["上侧键 / 下侧键", "当前悬停词：熟词 / 生词"],
  ["Ctrl + ,", "身份、兴趣与 AI 设置"],
  ["Ctrl + M", "最小化"],
  ["Ctrl + Shift + M / F11", "最大化或还原 / 全屏"],
  ["Alt + F4 / Ctrl + Q", "保存后关闭"],
  ["? / Esc", "快捷键帮助 / 关闭浮层"],
];
for (const [key, meaning] of shortcuts) {
  const row = document.createElement("div");
  row.className = "shortcut";
  const a = document.createElement("span"),
    b = document.createElement("kbd");
  a.textContent = meaning;
  b.textContent = key;
  row.append(a, b);
  $("shortcut-list").append(row);
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4000);
}
function error(e) {
  console.error(e);
  toast(e?.message || String(e));
}
function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}
function dialog(id) {
  if (id === "search-dialog") {
    if (!$(id).open) $(id).show();
  } else $(id).showModal();
}
function shapeProfile(result) {
  return parseProfile(
    typeof result === "string" ? result : result?.markdown || "",
  );
}
async function requestAI(kind, payload, signal) {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const cancel = () => {
    api.cancelAI(requestId).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await api.requestAI({ kind, payload, requestId });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
async function init() {
  if (!api) {
    toast("请通过 npm start 启动桌面应用");
    return;
  }
  api.onBeforeClose?.(() => closeApplication().catch(error));
  settingsData = await api.getSettings();
  state.settings = settingsData?.settings || settingsData || {};
  firstRun = !state.settings.onboardingComplete;
  profileData = await api.getProfile();
  state.profile = shapeProfile(profileData);
  const resources = await Promise.allSettled([loadLexicon(), loadDictionary()]);
  if (resources[0].status === "fulfilled") lexicon = resources[0].value;
  else toast("词库加载失败，手动标词仍可使用：" + resources[0].reason.message);
  if (resources[1].status === "fulfilled") dictionary = resources[1].value;
  else
    toast("本地词典加载失败，仍可使用 AI 释义：" + resources[1].reason.message);
  companion = new WordCompanion({
    getDictionaryGloss: (candidate) => dictionaryGloss(candidate, dictionary),
    loadGlossCache: () => api.getGlossCache(),
    saveGlossCache: (entries) => api.saveGlossCache(entries),
    getSettings: () => ({
      ...state.settings,
      lexicon,
      familiarButton: Number(state.settings.familiarButton ?? 4),
      unfamiliarButton: Number(state.settings.unfamiliarButton ?? 3),
    }),
    requestGloss: async (candidate, { signal } = {}) =>
      aiEnabled() ? requestAI("gloss", candidate, signal) : null,
    requestGlossBatch: async (candidates, { signal } = {}) => {
      if (!aiEnabled() || !candidates.length) return null;
      return requestAI(
        "glossBatch",
        {
          candidates: candidates.map((candidate) => ({
            word: candidate.word.replace(/-\s*\n\s*/g, ""),
            lemma: candidate.lemma,
            sentence: candidate.sentence || "",
            targetStart: candidate.targetStart,
            targetEnd: candidate.targetEnd,
          })),
        },
        signal,
      );
    },
    loadState: async () => state.settings.vocabulary || {},
    saveState: async (vocabulary) => {
      state.settings.vocabulary = vocabulary;
      await api.saveSettings(state.settings);
    },
    onChange: (event) => {
      if (event.type === "status")
        toast(
          `${event.word} · ${event.status === "known" ? "已标记熟词" : "已标记生词"}`,
        );
      if (event.type === "error") toast(event.message);
    },
  });
  await companion.initialize();
  bindPdfPan($("reader"), {
    isEnabled: () => !!state.pdf && !document.querySelector("dialog:modal"),
    onPanStart: () => {
      closeNoteCard();
      companion?.closeGloss();
      $("citation-card").hidden = true;
      getSelection()?.removeAllRanges();
    },
    onPanEnd: () => persistState().catch(error),
  });
  let externalOpenQueue = Promise.resolve();
  api.onOpenPdf?.((file) => {
    externalOpenQueue = externalOpenQueue
      .catch(() => {})
      .then(async () => {
        const active = document.querySelector("dialog:modal");
        if (active)
          await new Promise((resolve) =>
            active.addEventListener("close", resolve, { once: true }),
          );
        await openDocument(file);
      })
      .catch(error);
  });
  api.onOpenError?.((message) => toast(message));
  window.readerdApp = { openDocument, state, flush, addAnnotation, markRead };
  if (firstRun) {
    $("help-hint").textContent =
      "首次使用 · 1 / 2：快捷键。Ctrl + Enter 继续配置 AI · Alt + F4 退出";
    dialog("help");
    await setupReady;
  }
  await api.rendererReady?.();
}
async function closeApplication() {
  pendingWheelDelta = 0;
  companion?.stopPrefetch();
  await zoomQueue.catch(() => {});
  await flush();
  await companion?.queue;
  await companion?.flushGlossCache().catch(() => {});
  await api.windowAction("close");
}
async function openDocument(file) {
  if (!file) return;
  closeNoteCard();
  pendingWheelDelta = 0;
  if (wheelFrame !== null) {
    cancelAnimationFrame(wheelFrame);
    wheelFrame = null;
  }
  await zoomQueue.catch(() => {});
  searchMatches = [];
  searchIndex = -1;
  if (state.path) await flush();
  const token = ++session;
  observer?.disconnect();
  for (const view of state.views) {
    view.citationCleanup?.();
    companion?.detachPage(view.number);
  }
  if (state.loadingTask) await state.loadingTask.destroy();
  Object.assign(state, {
    documentId: crypto.randomUUID(),
    path: file.path,
    name: file.name || "文献",
    pages: [],
    views: [],
    annotations: [],
    undo: [],
    redo: [],
    outline: [],
    references: [],
    read: false,
    revision: 0,
    savedRevision: 0,
  });
  $("pages").replaceChildren();
  $("welcome").hidden = true;
  $("reader").classList.remove("is-empty");
  $("welcome").style.display = "none";
  $("reader").scrollTop = 0;
  $("outline").replaceChildren(make("p", "quiet", "正在提取章节…"));
  $("recommendations").replaceChildren(
    make("p", "quiet", "读完后，遇见下一篇。"),
    make("p", "subtle", "Ctrl + Enter 标记已读"),
  );
  document.title = `${state.name} · ReaderD`;
  const saved = (await api.loadState(state.path)) || {};
  state.annotations = saved.annotations || [];
  state.read = !!saved.read;
  state.cachedOutline = saved.outline || [];
  const bytes = new Uint8Array(file.data);
  state.loadingTask = pdfjs.getDocument({
    data: bytes,
    cMapUrl: new URL("../node_modules/pdfjs-dist/cmaps/", import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL(
      "../node_modules/pdfjs-dist/standard_fonts/",
      import.meta.url,
    ).href,
    wasmUrl: new URL("../node_modules/pdfjs-dist/wasm/", import.meta.url).href,
  });
  state.pdf = await state.loadingTask.promise;
  const metadata = await state.pdf.getMetadata().catch(() => null);
  state.title = metadata?.info?.Title?.trim() || state.name;
  const first = await state.pdf.getPage(1);
  state.scale = saved.scale || fitScale(first.getViewport({ scale: 1 }).width);
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const view = state.views[Number(entry.target.dataset.page) - 1];
        if (entry.isIntersecting) renderPage(view).catch(error);
        else releasePage(view);
      }
    },
    { root: $("reader"), rootMargin: "900px 0px" },
  );
  for (let number = 1; number <= state.pdf.numPages; number++) {
    if (token !== session) return;
    const page = await state.pdf.getPage(number),
      vp = page.getViewport({ scale: 1 });
    const el = make("section", "page");
    el.dataset.page = number;
    const canvas = document.createElement("canvas"),
      textLayer = make("div", "textLayer"),
      annotationLayer = make("div", "annotation-layer");
    el.append(canvas, textLayer, annotationLayer);
    const view = {
      number,
      page,
      el,
      canvas,
      textLayer,
      annotationLayer,
      width: vp.width,
      height: vp.height,
      rendered: false,
      task: null,
    };
    state.views.push(view);
    sizeView(view);
    $("pages").append(el);
    observer.observe(el);
  }
  $("reader").scrollTop = saved.scrollTop || 0;
  await renderPage(state.views[0]);
  toast(`${state.name} · ${state.pdf.numPages} 页`);
  await analyze(token);
  if (state.read) renderRecommendations();
}
function fitScale(width) {
  const style = getComputedStyle($("reader"));
  const available =
    $("reader").clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight);
  return Math.max(0.3, Math.min(1.65, available / width));
}
function sizeView(view) {
  view.el.style.width = `${view.width * state.scale}px`;
  view.el.style.height = `${view.height * state.scale}px`;
  view.el.style.setProperty("--scale-factor", state.scale);
  view.el.style.setProperty("--total-scale-factor", state.scale);
}
async function renderPage(view) {
  if (!view || view.rendered || view.task) return;
  view.rendered = true;
  const scale = state.scale,
    vp = view.page.getViewport({ scale }),
    ratio = devicePixelRatio || 1;
  view.canvas.width = Math.ceil(vp.width * ratio);
  view.canvas.height = Math.ceil(vp.height * ratio);
  view.canvas.style.width = `${vp.width}px`;
  view.canvas.style.height = `${vp.height}px`;
  view.task = view.page.render({
    canvasContext: view.canvas.getContext("2d"),
    viewport: vp,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
  });
  try {
    await view.task.promise;
    const content = await view.page.getTextContent();
    view.textLayer.replaceChildren();
    const layer = new pdfjs.TextLayer({
      textContentSource: content,
      container: view.textLayer,
      viewport: vp,
    });
    await layer.render();
    view.textTask = layer;
    decorateCitations(view);
    await companion?.attachPage({
      pageNumber: view.number,
      container: view.el,
      textLayer: view.textLayer,
      items: content.items,
    });
    paintAnnotations(view);
  } catch (e) {
    view.rendered = false;
    if (e.name !== "RenderingCancelledException") throw e;
  } finally {
    view.task = null;
  }
}
function releasePage(view) {
  if (!view || view.task || !view.rendered) return;
  const rect = view.el.getBoundingClientRect();
  if (rect.bottom > -1500 && rect.top < innerHeight + 1500) return;
  view.citationCleanup?.();
  companion?.detachPage(view.number);
  view.textTask?.cancel();
  view.textLayer.replaceChildren();
  view.annotationLayer.replaceChildren();
  view.canvas.width = 1;
  view.canvas.height = 1;
  view.rendered = false;
}
function textItemGeometry(view, item) {
  const viewport = view.page.getViewport({ scale: 1 });
  const m = pdfjs.Util.transform(viewport.transform, item.transform),
    height = Math.hypot(m[2], m[3]) || item.height || 10;
  const bounds = pdfRectToViewport(
    {
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      height: item.height || Math.abs(item.transform[3]),
    },
    viewport,
  );
  return { x: bounds.x, y: bounds.y + height, width: bounds.width, height };
}
async function analyze(token) {
  const pages = [];
  for (const view of state.views) {
    if (token !== session) return;
    const content = await view.page.getTextContent();
    pages.push({
      page: view.number,
      width: view.width,
      height: view.height,
      items: content.items
        .filter((i) => i.str)
        .map((i) => ({
          str: i.str,
          ...textItemGeometry(view, i),
          fontName: i.fontName,
        })),
    });
    if (view.number % 4 === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  state.pages = pages;
  const rawOutline = await state.pdf.getOutline();
  const native = [];
  async function walk(nodes, level = 1) {
    for (const node of nodes || []) {
      try {
        const destination = await resolveOutlineDestination(
          state.pdf,
          node.dest,
        );
        if (destination)
          native.push(
            bindSectionPosition(
              {
                title: node.title,
                ...destination,
                level,
                source: "bookmark",
              },
              pages,
            ),
          );
      } catch {}
      await walk(node.items, level + 1);
    }
  }
  await walk(rawOutline);
  if (token !== session) return;
  const result = analyzeDocument(pages, native);
  state.outline = result.outline;
  const candidates = headingCandidates(pages);
  const cached = resolveOutlineEntries(
    state.cachedOutline.filter((e) => e.source === "AI"),
    pages,
    candidates,
  );
  if (!native.length && cached.length) state.outline = cached;
  state.references = result.references;
  renderOutline();
  for (const view of state.views) if (view.rendered) decorateCitations(view);
  if (!native.length && !cached.length && aiEnabled()) {
    try {
      const sourceCandidates = candidates
        .filter((line) => line.text.length < 400)
        .map(({ text, page, y, height }) => ({ text, page, y, height }))
        .slice(0, 1800);
      const result = await api.requestAI({
        kind: "outline",
        payload: { candidates: sourceCandidates },
      });
      if (token !== session) return;
      let entries = result?.outline || result;
      if (typeof entries === "string") {
        entries = JSON.parse(entries.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        entries = entries.outline || entries;
      }
      if (Array.isArray(entries)) {
        const validated = resolveOutlineEntries(entries, pages, candidates);
        if (validated.length) {
          state.outline = validated;
          renderOutline();
        }
      }
    } catch (e) {
      toast(`AI 章节提取失败，使用版面识别：${e.message}`);
    }
  } else if (!native.length)
    toast("章节由版面识别生成；可在偏好中配置 AI 提升识别");
  await persistState();
}
function renderOutline() {
  state.outline = filterOutline(state.outline, state.pages, state.title).map(
    (item) => bindSectionPosition(item, state.pages),
  );
  const root = $("outline");
  root.replaceChildren();
  if (!state.outline.length) {
    root.append(make("p", "quiet", "未可靠识别到章节"));
    return;
  }
  for (const item of state.outline) {
    const a = make("a", "", item.title);
    a.href = "#";
    a.dataset.level = Math.min(3, item.level || 1);
    a.title = `${item.source === "AI" ? "AI 提取" : item.source === "bookmark" ? "PDF 书签" : "版面识别"} · ${item.title}`;
    a.onclick = (e) => {
      e.preventDefault();
      jump(item.page, item.y);
    };
    root.append(a);
  }
}
function jump(page, y = 0) {
  const view = state.views[page - 1];
  if (view)
    $("reader").scrollTo({
      top: sectionScrollTop($("reader"), view.el, y, state.scale),
      behavior: "smooth",
    });
}
function referenceElement(ref) {
  const el = make("div", "reference");
  const title = referenceLink(ref, `[${ref.number}] ${referenceTitle(ref)}`);
  el.append(title);
  if (ref.authors || ref.year || ref.journal)
    el.append(
      make(
        "p",
        "",
        [ref.authors, ref.year, ref.journal].filter(Boolean).join(" · "),
      ),
    );
  return el;
}
function referenceLink(ref, text) {
  const link = make("a", "", text);
  link.href = ref.doi ? `https://doi.org/${ref.doi}` : "#";
  link.title = "打开此文献的 DOI 页面";
  let opening = false;
  link.onclick = async (event) => {
    event.preventDefault();
    if (opening) return;
    opening = true;
    link.setAttribute("aria-busy", "true");
    try {
      if (!ref.doi) toast("正在查找这篇文献的 DOI…");
      const resolved = await api.openReference({
        doi: ref.doi,
        title: ref.title,
        authors: ref.authors,
        year: ref.year,
      });
      ref.doi = resolved.doi;
      link.href = resolved.url;
      link.dataset.doi = resolved.doi;
    } catch (e) {
      error(e);
    } finally {
      opening = false;
      link.setAttribute("aria-busy", "false");
    }
  };
  return link;
}
function referenceTitle(ref) {
  return (ref.title || ref.raw || "未识别题名")
    .replace(
      /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)?10\.\d{4,9}\/[^\s]+/gi,
      "",
    )
    .trim();
}
function decorateCitations(view) {
  view.citationCleanup?.();
  view.citationCleanup = bindCitationHover({
    container: view.el,
    textLayer: view.textLayer,
    references: state.references,
    onShow: ({ references, missingNumbers, x, y, uncertainty }) => {
      clearTimeout(hoverTimer);
      companion?.closeGloss();
      const card = $("citation-card");
      card.replaceChildren(...references.map(referenceElement));
      if (missingNumbers.length)
        card.append(
          make("p", "subtle", "无法确认对应条目：" + missingNumbers.join(", ")),
        );
      if (uncertainty) card.append(make("p", "subtle", uncertainty));
      card.hidden = false;
      card.style.left = Math.max(12, Math.min(innerWidth - 480, x + 14)) + "px";
      card.style.top =
        Math.max(12, Math.min(innerHeight - card.offsetHeight - 20, y + 20)) +
        "px";
    },
    onHide: () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => ($("citation-card").hidden = true), 350);
    },
  });
}
$("citation-card").addEventListener("mouseenter", () =>
  clearTimeout(hoverTimer),
);
$("citation-card").addEventListener(
  "mouseleave",
  () => ($("citation-card").hidden = true),
);
let hoveredAnnotation = null,
  activeNoteId = null;
function closeNoteCard() {
  activeNoteId = null;
  $("note-card").hidden = true;
}
function showNoteCard(id) {
  const note = state.annotations.find((a) => a.id === id && a.type === "note");
  if (!note) return;
  activeNoteId = id;
  $("note-card-content").textContent = note.text || "（空批注）";
  $("note-card").hidden = false;
  positionNoteCard();
}
function positionNoteCard() {
  if (!activeNoteId) return;
  const note = state.annotations.find((a) => a.id === activeNoteId);
  if (!note) {
    closeNoteCard();
    return;
  }
  const marker = document.querySelector(
    `[data-annotation-id="${CSS.escape(activeNoteId)}"]`,
  );
  const card = $("note-card"),
    reader = $("reader").getBoundingClientRect();
  const anchor = marker?.getBoundingClientRect();
  if (
    !anchor ||
    anchor.bottom < reader.top ||
    anchor.top > reader.bottom ||
    anchor.right < reader.left ||
    anchor.left > reader.right
  ) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("note-card-content").textContent = note.text || "（空批注）";
  const width = Math.min(320, reader.width - 24);
  card.style.width = `${width}px`;
  let left = anchor.right + 10;
  if (left + width > reader.right - 8) left = anchor.left - width - 10;
  left = Math.max(reader.left + 8, Math.min(reader.right - width - 8, left));
  card.style.maxHeight = `${Math.min(420, reader.height - 24)}px`;
  let top = Math.max(
    reader.top + 12,
    Math.min(reader.bottom - card.offsetHeight - 12, anchor.top - 8),
  );
  if (
    anchor.right + 10 + width > reader.right - 8 &&
    anchor.left - width - 10 < reader.left + 8
  ) {
    const below = reader.bottom - anchor.bottom - 20,
      above = anchor.top - reader.top - 20;
    card.style.maxHeight = `${Math.max(80, Math.min(420, Math.max(below, above)))}px`;
    top =
      below >= above ? anchor.bottom + 10 : anchor.top - card.offsetHeight - 10;
  }
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}
function editNote(ann) {
  pendingNote = { edit: ann.id, selection: null };
  $("note-text").value = ann.text;
  dialog("note-dialog");
  $("note-text").focus();
}
function paintAnnotations(view) {
  view.annotationLayer.replaceChildren();
  for (const ann of state.annotations.filter((a) => a.page === view.number)) {
    for (const storedRect of ann.type === "note"
      ? ann.rects.slice(-1)
      : ann.rects) {
      const pixel =
        ann.coordinateSpace === "pdf"
          ? pdfRectToViewport(storedRect, view.page.getViewport({ scale: 1 }))
          : storedRect;
      const rect = pixel;
      const notePoint =
        ann.type === "note"
          ? noteMarkerPoint(ann, view.page.getViewport({ scale: 1 }))
          : null;
      const el = make("div", `annotation ${ann.type}`);
      Object.assign(
        el.style,
        ann.type === "note"
          ? {
              left: `${notePoint.x * state.scale + 2 - 9}px`,
              top: `${notePoint.y * state.scale - 9}px`,
              width: "18px",
              height: "18px",
            }
          : {
              left: `${rect.x * state.scale}px`,
              top: `${rect.y * state.scale}px`,
              width: `${rect.width * state.scale}px`,
              height: `${rect.height * state.scale}px`,
            },
      );
      el.dataset.annotationId = ann.id;
      if (ann.type === "note") {
        el.setAttribute("role", "button");
        el.tabIndex = 0;
        el.setAttribute("aria-label", "打开文字批注");
        el.onclick = (event) => {
          event.stopPropagation();
          showNoteCard(ann.id);
        };
        el.onkeydown = (event) => {
          if (
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            event.stopPropagation();
            showNoteCard(ann.id);
          }
        };
      } else el.title = ann.text || "批注";
      el.onmouseenter = () => {
        hoveredAnnotation = ann.id;
        if (ann.type === "note") showNoteCard(ann.id);
      };
      el.onmouseleave = () => {
        hoveredAnnotation = null;
        if (ann.type === "note" && activeNoteId === ann.id) closeNoteCard();
      };
      el.ondblclick = () => {
        if (ann.type === "note") {
          editNote(ann);
        }
      };
      view.annotationLayer.append(el);
    }
  }
  if (activeNoteId) positionNoteCard();
}
function selectionGeometry() {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0),
    groups = [];
  for (const view of state.views) {
    if (
      !view.textLayer.contains(range.startContainer) &&
      !view.textLayer.contains(range.endContainer) &&
      !range.intersectsNode(view.textLayer)
    )
      continue;
    const box = view.el.getBoundingClientRect(),
      rects = [];
    for (const rect of range.getClientRects()) {
      if (
        rect.width < 1 ||
        rect.height < 1 ||
        rect.top < box.top - 1 ||
        rect.bottom > box.bottom + 1
      )
        continue;
      rects.push(
        viewportClientRectToPdf(
          rect,
          box,
          view.page.getViewport({ scale: state.scale }),
        ),
      );
    }
    if (rects.length)
      groups.push({
        page: view.number,
        rects,
        anchor: selectionEndAnchor(
          range,
          view.textLayer,
          box,
          view.page.getViewport({ scale: state.scale }),
        ),
      });
  }
  return groups.length ? { groups, text: selection.toString() } : null;
}
function pushUndo() {
  state.undo.push(structuredClone(state.annotations));
  state.redo = [];
  if (state.undo.length > 50) state.undo.shift();
}
function changed() {
  state.revision++;
  for (const view of state.views) if (view.rendered) paintAnnotations(view);
  positionNoteCard();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush().catch(error), 900);
}
function addAnnotation(type, selection = selectionGeometry(), text = "") {
  if (!selection) {
    toast("请先选择正文文字");
    return;
  }
  pushUndo();
  for (const group of selection.groups)
    state.annotations.push({
      id: crypto.randomUUID(),
      type,
      coordinateSpace: "pdf",
      page: group.page,
      rects: group.rects,
      ...(type === "note" && group.anchor ? { anchor: group.anchor } : {}),
      text: type === "note" ? text : selection.text,
      createdAt: new Date().toISOString(),
    });
  getSelection()?.removeAllRanges();
  changed();
  toast(type === "note" ? "批注已添加，正在写入 PDF" : "已标注，正在写入 PDF");
}
let pendingNote = null;
async function persistState() {
  if (!state.path) return;
  await api.saveState(state.path, {
    annotations: state.annotations,
    scale: state.scale,
    scrollTop: $("reader").scrollTop,
    read: state.read,
    outline: state.outline,
  });
}
async function flush() {
  clearTimeout(saveTimer);
  const path = state.path;
  if (!path) return;
  const revision = state.revision,
    annotations = structuredClone(state.annotations);
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      if (revision !== state.savedRevision) {
        await api.savePdf({ path, annotations });
        state.savedRevision = revision;
      }
      await persistState();
    });
  return saveChain;
}
let zoomQueue = Promise.resolve();
function zoom(factor, anchor) {
  const documentSession = session;
  const operation = zoomQueue
    .catch(() => {})
    .then(() =>
      documentSession === session ? applyZoom(factor, anchor) : undefined,
    );
  zoomQueue = operation;
  return operation;
}
async function applyZoom(factor, anchor) {
  if (!state.pdf) return;
  closeNoteCard();
  const reader = $("reader");
  const previous = state.scale,
    top = $("reader").scrollTop;
  const anchorView =
    anchor &&
    state.views.find((view) => {
      const rect = view.el.getBoundingClientRect();
      return (
        anchor.x >= rect.left &&
        anchor.x <= rect.right &&
        anchor.y >= rect.top &&
        anchor.y <= rect.bottom
      );
    });
  const anchorRect = anchorView?.el.getBoundingClientRect();
  const pagePoint = anchorRect
    ? {
        x: (anchor.x - anchorRect.left) / previous,
        y: (anchor.y - anchorRect.top) / previous,
      }
    : null;
  state.scale =
    factor === 0
      ? fitScale(state.views[0].width)
      : Math.min(3, Math.max(0.3, state.scale * factor));
  if (state.scale === previous) return;
  for (const view of state.views) {
    if (view.task) {
      view.task.cancel();
      try {
        await view.task.promise;
      } catch {}
    }
    view.citationCleanup?.();
    companion?.detachPage(view.number);
    view.rendered = false;
    view.textTask?.cancel();
    view.textLayer.replaceChildren();
    sizeView(view);
    paintAnnotations(view);
  }
  $("reader").scrollTop = (top * state.scale) / previous;
  if (pagePoint) {
    const rect = anchorView.el.getBoundingClientRect();
    reader.scrollTop += rect.top + pagePoint.y * state.scale - anchor.y;
    reader.scrollLeft += rect.left + pagePoint.x * state.scale - anchor.x;
  }
  for (const view of state.views) {
    const r = view.el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight + 800) await renderPage(view);
  }
  await persistState();
}
function renderRecommendations() {
  const root = $("recommendations");
  root.replaceChildren();
  const recommendations = recommendReferences(state.references, state.profile, {
    title: state.title || state.name,
  });
  if (!recommendations.length) {
    root.append(make("p", "quiet", "暂未提取到可推荐的参考文献"));
    return;
  }
  recommendations.forEach((ref, index) => {
    const card = make("article", "recommendation");
    card.append(make("div", "number", String(index + 1).padStart(2, "0")));
    const heading = make("h3"),
      link = referenceLink(ref, referenceTitle(ref));
    heading.append(link);
    card.append(
      heading,
      make(
        "p",
        "",
        [`[${ref.number}]`, ref.authors, ref.year, ref.journal]
          .filter(Boolean)
          .join(" · "),
      ),
      make("p", "", ref.reason || "依据参考文献题名与近期兴趣匹配"),
    );
    root.append(card);
  });
  root.append(make("p", "subtle", "推荐依据题名与引用文本，尚未核实全文。"));
  if (recommendations.length < 3)
    root.append(make("p", "subtle", "可用条目不足三条，显示实际数量。"));
}
async function markRead() {
  if (!state.pdf) return;
  if (!state.pages.length) {
    toast("正在提取论文，请稍后标记已读");
    return;
  }
  state.read = true;
  profileData = await api.getProfile();
  state.profile = shapeProfile(profileData);
  const history = state.profile.history || [];
  state.profile.history = [
    {
      title: state.title || state.name,
      fileName: state.name,
      readAt: new Date().toISOString(),
      topics: state.outline.slice(0, 12).map((o) => o.title),
      annotations: state.annotations
        .map((a) => a.text)
        .filter(Boolean)
        .slice(0, 30),
    },
    ...history.filter((p) => p.title !== (state.title || state.name)),
  ].slice(0, 100);
  await saveProfile(true);
  renderRecommendations();
  await persistState();
  toast("已记录阅读 · 推荐已更新");
}
async function saveProfile(historyOnly = false) {
  const latest = await api.getProfile();
  const markdown = updateProfile(latest.markdown, state.profile, {
    historyOnly,
  });
  profileData = await api.saveProfile(
    historyOnly ? { markdown, automaticOnly: true } : markdown,
  );
  state.profile = parseProfile(profileData.markdown);
}
async function showSettings() {
  profileData = await api.getProfile();
  state.profile = shapeProfile(profileData);
  $("profile-identity").value = state.profile.identity || "";
  $("profile-direction").value = state.profile.direction || "";
  $("profile-interests").value = (state.profile.interests || []).join(", ");
  $("ai-provider").value = state.settings.provider || "api";
  $("codex-path").value = state.settings.codexPath || "";
  updateProviderFields();
  $("settings-title").textContent = firstRun
    ? "首次使用 · 2 / 2：连接 AI"
    : "阅读偏好";
  $("setup-intro").hidden = !firstRun;
  $("settings-cancel-hint").textContent = firstRun
    ? "Alt + F4 退出"
    : "Esc 取消";
  $("ai-status").textContent = "";
  $("ai-endpoint").value = state.settings.endpoint || "";
  $("ai-model").value = state.settings.model || "";
  $("ai-key").value = "";
  $("upper-button").value = state.settings.familiarButton ?? 4;
  $("lower-button").value = state.settings.unfamiliarButton ?? 3;
  $("profile-location").textContent =
    `阅读画像：${profileData?.path || "应用数据目录 / reading-profile.md"}`;
  dialog("settings-dialog");
}
function updateProviderFields() {
  const local = $("ai-provider").value === "codex";
  for (const el of document.querySelectorAll(".api-field")) el.hidden = local;
  for (const el of document.querySelectorAll(".codex-field"))
    el.hidden = !local;
}
$("ai-provider").addEventListener("change", updateProviderFields);
for (const id of ["help", "settings-dialog"])
  $(id).addEventListener("cancel", (event) => {
    if (firstRun || setupBusy) event.preventDefault();
  });
async function saveSettings() {
  if (setupBusy) return;
  if ($("upper-button").value === $("lower-button").value) {
    toast("上下侧键不能设置为同一个按钮");
    return;
  }
  state.profile = {
    ...state.profile,
    identity: $("profile-identity").value.trim(),
    direction: $("profile-direction").value.trim(),
    interests: $("profile-interests")
      .value.split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const nextSettings = {
    ...state.settings,
    provider: $("ai-provider").value,
    codexPath: $("codex-path").value.trim(),
    endpoint: $("ai-endpoint").value.trim(),
    model: $("ai-model").value.trim(),
    familiarButton: Number($("upper-button").value),
    unfamiliarButton: Number($("lower-button").value),
  };
  if ($("ai-key").value) nextSettings.apiKey = $("ai-key").value;
  setupBusy = true;
  $("ai-status").textContent = "正在测试连接，请稍候…";
  try {
    const changedConnection =
      ["endpoint", "model", "codexPath"].some(
        (key) => (nextSettings[key] || "") !== (state.settings[key] || ""),
      ) ||
      nextSettings.provider !== (state.settings.provider || "api") ||
      !!nextSettings.apiKey;
    if (firstRun || changedConnection) await api.testAI(nextSettings);
    nextSettings.onboardingComplete = true;
    await api.saveSettings(nextSettings);
    state.settings = await api.getSettings();
    $("ai-key").value = "";
  } catch (e) {
    $("ai-status").textContent = e.message;
    return;
  } finally {
    setupBusy = false;
  }
  await saveProfile();
  const wasFirstRun = firstRun;
  firstRun = false;
  $("help-hint").textContent = "Esc 关闭 · 窗口顶部空白区域可拖动";
  $("settings-dialog").close();
  if (wasFirstRun) finishSetup();
  $("reader").focus({ preventScroll: true });
  toast("偏好与阅读画像已保存");
}
let searchMatches = [],
  searchIndex = -1;
function searchNext() {
  const query = $("search-text").value.trim().toLowerCase();
  if (!query) return;
  const signature = searchMatches.query;
  if (signature !== query) {
    searchMatches = state.pages.flatMap((p) =>
      p.items
        .filter((i) => i.str.toLowerCase().includes(query))
        .map((i) => ({ ...i, page: p.page })),
    );
    searchMatches.query = query;
    searchIndex = -1;
  }
  if (!searchMatches.length) {
    $("search-status").textContent = "未找到匹配";
    return;
  }
  const item = searchMatches[++searchIndex % searchMatches.length];
  $("search-status").textContent =
    `${(searchIndex % searchMatches.length) + 1} / ${searchMatches.length}`;
  jump(item.page, Math.max(0, item.y - 80));
  for (const el of document.querySelectorAll(".search-match")) el.remove();
  const view = state.views[item.page - 1],
    marker = make("div", "search-match");
  Object.assign(marker.style, {
    left: `${item.x * state.scale}px`,
    top: `${(item.y - item.height) * state.scale}px`,
    width: `${item.width * state.scale}px`,
    height: `${item.height * state.scale * 1.3}px`,
  });
  view.el.append(marker);
}
document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey,
    key = event.key.toLowerCase(),
    search = $("search-dialog"),
    active =
      document.querySelector("dialog:modal") ||
      (search.open &&
      (search.contains(event.target) ||
        event.key === "Escape" ||
        (mod && key === "f"))
        ? search
        : null);
  if (active) {
    if (active === search && event.key === "Escape") {
      event.preventDefault();
      search.close();
      $("reader").focus({ preventScroll: true });
      return;
    }
    if (active === search && mod && key === "f") {
      event.preventDefault();
      $("search-text").focus();
      $("search-text").select();
      return;
    }
    if (mod && key === "q") {
      event.preventDefault();
      closeApplication().catch(error);
      return;
    }
    if (event.key === "Escape") return;
    if (mod && event.key === "Enter") {
      event.preventDefault();
      if (active.id === "help" && firstRun) {
        active.close();
        showSettings().catch(error);
      }
      if (active.id === "settings-dialog") saveSettings().catch(error);
      if (active.id === "note-dialog") {
        if (pendingNote?.edit) {
          pushUndo();
          state.annotations.find((a) => a.id === pendingNote.edit).text =
            $("note-text").value;
          changed();
        } else
          addAnnotation("note", pendingNote?.selection, $("note-text").value);
        active.close();
        $("reader").focus({ preventScroll: true });
      }
    }
    if (active.id === "search-dialog" && event.key === "Enter") {
      event.preventDefault();
      searchNext();
    }
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  const run = (fn) => {
    event.preventDefault();
    Promise.resolve().then(fn).catch(error);
  };
  if (mod && key === "o")
    return run(async () => openDocument(await api.openPdf()));
  if (mod && key === "s")
    return run(async () => {
      await flush();
      toast("批注已写入 PDF");
    });
  if (mod && key === ",") return run(showSettings);
  if (mod && key === "f")
    return run(() => {
      dialog("search-dialog");
      $("search-text").focus();
    });
  if (mod && event.key === "Enter") return run(markRead);
  if (mod && ["+", "=", "-", "0"].includes(key))
    return run(() => zoom(key === "0" ? 0 : key === "-" ? 1 / 1.15 : 1.15));
  if (mod && key === "z")
    return run(() => {
      const from = event.shiftKey ? state.redo : state.undo,
        to = event.shiftKey ? state.undo : state.redo;
      if (from.length) {
        to.push(structuredClone(state.annotations));
        state.annotations = from.pop();
        changed();
      }
    });
  if (mod && key === "m")
    return run(() =>
      api.windowAction(event.shiftKey ? "toggleMaximize" : "minimize"),
    );
  if (event.key === "F11") return run(() => api.windowAction("fullscreen"));
  if (mod && key === "q") return run(closeApplication);
  if (event.key === "?" || event.key === "F1") return run(() => dialog("help"));
  if (event.key === "Escape") {
    closeNoteCard();
    $("citation-card").hidden = true;
    getSelection()?.removeAllRanges();
    return;
  }
  if (!mod && !event.altKey && ["w", "s", "a"].includes(key))
    return run(() => {
      const selection = selectionGeometry();
      if (!selection) {
        toast("请先选择正文文字");
        return;
      }
      if (key === "a") {
        pendingNote = { selection };
        $("note-text").value = "";
        dialog("note-dialog");
        $("note-text").focus();
      } else addAnnotation(key === "w" ? "highlight" : "underline", selection);
    });
  if (!mod && !event.altKey && key === "d" && hoveredAnnotation)
    return run(() => {
      pushUndo();
      state.annotations = state.annotations.filter(
        (a) => a.id !== hoveredAnnotation,
      );
      hoveredAnnotation = null;
      changed();
    });
});
function prefetchVisiblePages() {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    if (!state.pdf) return;
    const reader = $("reader").getBoundingClientRect();
    for (const view of state.views) {
      const rect = view.el.getBoundingClientRect();
      if (rect.bottom > reader.top && rect.top < reader.bottom)
        companion?.prefetchPage(view.number).catch(() => {});
    }
  }, 80);
}
$("reader").addEventListener(
  "scroll",
  () => {
    positionNoteCard();
    companion?.closeGloss();
    $("citation-card").hidden = true;
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => persistState().catch(error), 500);
    prefetchVisiblePages();
    const index = state.outline.findLastIndex((o) => {
      const view = state.views[o.page - 1];
      return (
        view &&
        view.el.offsetTop + o.y * state.scale < $("reader").scrollTop + 160
      );
    });
    [...$("outline").children].forEach((el, i) =>
      el.classList.toggle("active", i === index),
    );
  },
  { passive: true },
);
document.addEventListener("auxclick", (event) => {
  if (event.button === 3 || event.button === 4) event.preventDefault();
});
let pendingWheelDelta = 0,
  wheelFrame = null,
  wheelRunning = false,
  wheelAnchor = null;
async function drainWheelZoom() {
  if (wheelRunning) return;
  wheelRunning = true;
  try {
    while (pendingWheelDelta) {
      const delta = pendingWheelDelta,
        anchor = wheelAnchor;
      pendingWheelDelta = 0;
      await zoom(Math.exp(-delta * 0.0014), anchor);
    }
  } catch (e) {
    error(e);
  } finally {
    wheelRunning = false;
  }
}
document.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return;
    // Prevent Chromium's whole-window zoom, including over the side panels.
    event.preventDefault();
    if (
      !state.pdf ||
      document.querySelector("dialog:modal") ||
      !$("reader").contains(event.target) ||
      !event.deltaY
    )
      return;
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? $("reader").clientHeight
          : 1;
    pendingWheelDelta = Math.max(
      -600,
      Math.min(600, pendingWheelDelta + event.deltaY * unit),
    );
    wheelAnchor = { x: event.clientX, y: event.clientY };
    if (wheelFrame === null)
      wheelFrame = requestAnimationFrame(() => {
        wheelFrame = null;
        drainWheelZoom();
      });
  },
  { passive: false },
);
window.addEventListener("error", (event) =>
  error(event.error || event.message),
);
window.addEventListener("resize", positionNoteCard);
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("close", () =>
    $("reader").focus({ preventScroll: true }),
  );
init().catch(error);
