import core from "./readerc-core.js";
export { loadLexicon } from "./lexicon.js";

const EMPTY_LEXICON = Object.freeze({
  entries: Object.freeze({}),
  forms: Object.freeze({}),
});
const STATUS = Object.freeze({
  familiar: "known",
  unfamiliar: "unknown",
  known: "known",
  unknown: "unknown",
});
const EDITABLE = 'input,textarea,[contenteditable],[role="textbox"]';
const CACHE_LIMIT = 2000;
const PREFETCH_BATCH = 10;
const PREFETCH_LIMIT = 60;
const CODEX_PREFETCH_LIMIT = 12;
const PREFETCH_CONCURRENCY = 6;

function aiConfigured(settings = {}) {
  return (
    settings.provider === "codex" || !!(settings.endpoint && settings.model)
  );
}

/** Adapted from readerc's non-destructive PDF.js text index. Never replaces text nodes. */
export function indexText(layer) {
  const walker = layer.ownerDocument.createTreeWalker(layer, 4);
  const segments = [];
  let text = "",
    previous = null,
    node;
  while ((node = walker.nextNode())) {
    if (
      !node.nodeValue?.trim() ||
      node.parentElement?.closest(".endOfContent,[data-readerd-word-owned]")
    )
      continue;
    const rect = node.parentElement.getBoundingClientRect();
    if (previous && node.parentElement !== previous.node.parentElement) {
      const line =
        Math.abs(rect.top - previous.rect.top) >
        Math.max(3, rect.height * 0.45);
      const space =
        rect.left - previous.rect.right > Math.max(1, rect.height * 0.1);
      if ((line || space) && !/\s$/.test(text) && !/^\s/.test(node.nodeValue))
        text += line ? "\n" : " ";
    }
    segments.push({
      node,
      start: text.length,
      end: text.length + node.nodeValue.length,
    });
    text += node.nodeValue;
    previous = { node, rect };
  }
  return { text, segments };
}

export function makeRange(doc, segments, start, end) {
  const first = segments.find(
    (segment) => segment.start <= start && segment.end > start,
  );
  const last = segments.find(
    (segment) => segment.start < end && segment.end >= end,
  );
  if (!first || !last) return null;
  const range = doc.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

export function sideButtonStatus(button, settings = {}) {
  const familiar = Number(settings.familiarButton ?? 4);
  const unfamiliar = Number(settings.unfamiliarButton ?? 3);
  if (
    ![3, 4].includes(familiar) ||
    ![3, 4].includes(unfamiliar) ||
    familiar === unfamiliar
  )
    return null;
  return button === familiar
    ? "known"
    : button === unfamiliar
      ? "unknown"
      : null;
}

/** Framework-free readerc adapter. State uses readerc's known/unknown vocabulary format. */
export class WordCompanion {
  constructor({
    getSettings = () => ({}),
    requestGloss,
    requestGlossBatch,
    onChange = () => {},
    loadState = async () => ({}),
    saveState = async () => {},
  } = {}) {
    Object.assign(this, {
      getSettings,
      requestGloss,
      requestGlossBatch,
      onChange,
      loadState,
      saveState,
    });
    this.vocabulary = Object.create(null);
    this.pages = new Map();
    this.cache = new Map();
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.prefetchQueued = new Set();
    this.prefetchActive = 0;
    this.prefetchWaiting = [];
    this.prefetchFailures = 0;
    this.prefetchPausedUntil = 0;
    this.prefetchStopped = false;
    this.hover = null;
    this.sequence = 0;
    this.disposed = false;
  }

  async initialize() {
    const stored = await this.loadState();
    if (!this.disposed)
      this.vocabulary = core.cleanVocabulary(stored?.vocabulary ?? stored);
    return this;
  }

  lexicon() {
    const value = this.getSettings().lexicon;
    return value?.entries && value?.forms ? value : EMPTY_LEXICON;
  }

  aiEnabled() {
    return aiConfigured(this.getSettings());
  }

  glossKey(candidate) {
    const settings = this.getSettings();
    // Codex may use neither endpoint nor model, so include its executable in
    // the cache identity to avoid reusing another provider's glosses.
    const scoped =
      settings.provider === "codex"
        ? { ...settings, model: `codex:${settings.codexPath || "auto"}` }
        : settings;
    return core.cacheKey(candidate, scoped);
  }

  normalizeGloss(raw) {
    const result = typeof raw === "string" ? { gloss: raw } : raw;
    return result?.gloss ? result : null;
  }

  rememberGloss(key, result) {
    this.cache.delete(key);
    this.cache.set(key, result);
    while (this.cache.size > CACHE_LIMIT)
      this.cache.delete(this.cache.keys().next().value);
  }

  isPageVisible(page) {
    const rect = page.container?.getBoundingClientRect?.();
    const win = page.container?.ownerDocument?.defaultView;
    if (!rect || !win) return false;
    return (
      rect.bottom > 0 &&
      rect.top < win.innerHeight &&
      rect.right > 0 &&
      rect.left < win.innerWidth
    );
  }

  /** Warm the gloss cache for a rendered page shortly after it becomes visible. */
  schedulePrefetch(page) {
    if (this.disposed || this.prefetchStopped || page.prefetchScheduled) return;
    if (
      !this.requestGlossBatch ||
      !this.aiEnabled() ||
      !this.isPageVisible(page)
    )
      return;
    const delay = this.getSettings().provider === "codex" ? 1200 : 60;
    page.prefetchScheduled = setTimeout(() => {
      page.prefetchScheduled = null;
      this.prefetchPage(page).catch(() => {});
    }, delay);
  }

  acquirePrefetchSlot() {
    if (this.prefetchActive < PREFETCH_CONCURRENCY) {
      this.prefetchActive++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.prefetchWaiting.push(resolve));
  }

  releasePrefetchSlot() {
    this.prefetchActive = Math.max(0, this.prefetchActive - 1);
    const next = this.prefetchWaiting.shift();
    if (next) {
      this.prefetchActive++;
      next();
    }
  }

  clearPrefetchGroup(group) {
    for (const candidate of group)
      this.prefetchQueued.delete(this.glossKey(candidate));
  }

  async runPrefetch(group, page) {
    await this.acquirePrefetchSlot();
    try {
      if (this.disposed || this.prefetchStopped) {
        this.clearPrefetchGroup(group);
        return;
      }
      // A detached or re-rendered page must not keep prefetching.
      if (this.pages.get(page.pageNumber) !== page) {
        this.clearPrefetchGroup(group);
        return;
      }
      await this.prefetchGroup(group);
    } finally {
      this.releasePrefetchSlot();
    }
  }

  async prefetchPage(target) {
    const page =
      typeof target === "object" ? target : this.pages.get(Number(target));
    if (!page || this.disposed || this.prefetchStopped) return;
    if (
      !this.requestGlossBatch ||
      !this.aiEnabled() ||
      !this.isPageVisible(page)
    )
      return;
    if (Date.now() < this.prefetchPausedUntil) return;
    const settings = this.getSettings();
    const limit =
      settings.provider === "codex" ? CODEX_PREFETCH_LIMIT : PREFETCH_LIMIT;
    const groups = new Map();
    let count = 0;
    for (const hit of page.hits || []) {
      if (count >= limit) break;
      if (!hit.prefetch) continue;
      const candidate = hit.candidate;
      if (this.vocabulary[candidate.lemma]?.state === "known") continue;
      const key = this.glossKey(candidate);
      if (
        this.cache.has(key) ||
        this.pending.has(key) ||
        this.prefetchQueued.has(key) ||
        !candidate.sentence
      )
        continue;
      let group = groups.get(candidate.sentence);
      if (!group) {
        group = [];
        groups.set(candidate.sentence, group);
      }
      if (group.length >= PREFETCH_BATCH) continue;
      group.push(candidate);
      this.prefetchQueued.add(key);
      count++;
    }
    const jobs = [];
    for (const group of groups.values())
      jobs.push(this.runPrefetch(group, page));
    // Match ReaderC: warm all sentence groups in parallel (bounded here) so a
    // later sentence is not stuck behind a long queue.
    return Promise.allSettled(jobs);
  }

  async prefetchGroup(candidates) {
    const keys = candidates.map((candidate) => this.glossKey(candidate));
    try {
      if (this.disposed || this.prefetchStopped) return;
      if (Date.now() < this.prefetchPausedUntil) return;
      const entries = [];
      for (const [index, candidate] of candidates.entries()) {
        const key = keys[index];
        if (this.cache.has(key) || this.pending.has(key)) continue;
        entries.push({ candidate, key });
      }
      if (!entries.length) return;
      const fresh = entries.map((entry) => entry.candidate);
      const batch = (async () => {
        let raw;
        try {
          raw = await this.requestGlossBatch(fresh);
        } catch {
          this.notePrefetchFailure();
          return new Map();
        }
        try {
          const reply =
            typeof raw === "string"
              ? { choices: [{ message: { content: raw } }] }
              : raw;
          const glosses = core.parseBatchGloss(reply, fresh);
          const results = new Map();
          for (const { candidate, key } of entries) {
            const gloss = glosses.get(candidate);
            if (!gloss) continue;
            const result = { gloss, source: "prefetch" };
            this.rememberGloss(key, result);
            results.set(candidate, result);
          }
          this.prefetchFailures = 0;
          return results;
        } catch {
          this.notePrefetchFailure();
          return new Map();
        }
      })();
      for (const { candidate, key } of entries) {
        const result = batch.then((results) => results.get(candidate) || null);
        this.pending.set(key, result);
        result
          .finally(() => {
            if (this.pending.get(key) === result) this.pending.delete(key);
          })
          .catch(() => {});
      }
      await batch;
    } finally {
      for (const key of keys) this.prefetchQueued.delete(key);
    }
  }

  notePrefetchFailure() {
    this.prefetchFailures++;
    // Do not hammer a failing endpoint; hover still performs a direct retry.
    if (this.prefetchFailures >= 2)
      this.prefetchPausedUntil = Date.now() + 30000;
  }

  stopPrefetch() {
    this.prefetchStopped = true;
    for (const page of this.pages.values()) {
      clearTimeout(page.prefetchScheduled);
      page.prefetchScheduled = null;
    }
    const waiting = this.prefetchWaiting.splice(0);
    for (const resolve of waiting) resolve();
  }

  async setWordStatus(word, status) {
    const lemma = core.canonical(word, this.lexicon());
    const state = STATUS[status];
    if (!core.validKey(lemma) || !state) throw new Error("词条或状态无效。");
    const work = this.queue.then(async () => {
      const next = {
        ...this.vocabulary,
        [lemma]: { state, updatedAt: new Date().toISOString() },
      };
      await this.saveState(next);
      if (this.disposed) return;
      this.vocabulary = core.cleanVocabulary(next);
      for (const page of this.pages.values()) this.drawPage(page);
      this.closeGloss();
      this.onChange({
        type: "status",
        word: lemma,
        status: state,
        message: `已标为${state === "known" ? "熟词" : "生词"}：${lemma}`,
      });
    });
    this.queue = work.catch(() => {});
    return work;
  }

  async attachPage({ pageNumber, container, textLayer, items }) {
    if (this.disposed) return;
    this.detachPage(pageNumber);
    const page = { pageNumber, container, textLayer, items, cleanup: [] };
    this.pages.set(pageNumber, page);
    const listen = (type, callback, options) => {
      container.addEventListener(type, callback, options);
      page.cleanup.push(() =>
        container.removeEventListener(type, callback, options),
      );
    };
    listen("pointermove", (event) => this.handlePointer(event), {
      passive: true,
    });
    listen("pointerleave", () => this.closeGloss());
    listen(
      "pointerdown",
      (event) => {
        if (event.button === 3 || event.button === 4)
          this.handleMouseSideButton(event);
        else this.closeGloss();
      },
      true,
    );
    // Chromium defaults to back/forward navigation on side-button mouseup/auxclick.
    for (const type of ["mousedown", "mouseup", "auxclick"])
      listen(
        type,
        (event) => {
          if (event.button === 3 || event.button === 4) {
            event.preventDefault();
            event.stopPropagation();
          }
        },
        true,
      );
    this.drawPage(page);
    this.schedulePrefetch(page);
  }

  drawPage(page) {
    page.overlay?.remove();
    page.hits = [];
    if (this.getSettings().enabled === false) return;
    const { text, segments } = indexText(page.textLayer);
    page.indexed = { text, segments };
    const settings = this.getSettings(),
      lexicon = this.lexicon();
    const automatic = core.candidates(text, lexicon, this.vocabulary, settings);
    const byPosition = new Map(
      automatic.map((candidate) => [
        `${candidate.start}:${candidate.end}`,
        candidate,
      ]),
    );
    const candidates = [...automatic];
    for (const token of core.tokenize(text)) {
      if (token.word.length < 2 || core.PREPOSITIONS.has(token.normalized))
        continue;
      if (
        automatic.some(
          (candidate) =>
            candidate.start <= token.start && candidate.end >= token.end,
        )
      )
        continue;
      const lemma = core.canonical(token.word, lexicon);
      candidates.push({
        ...token,
        lemma,
        ...core.sentenceAt(text, token.start, token.end),
      });
    }
    const doc = page.container.ownerDocument;
    const overlay = doc.createElement("div");
    overlay.dataset.readerdWordOwned = "markers";
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;";
    page.overlay = overlay;
    const pageRect = page.container.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return;
    const sx = (page.container.offsetWidth || pageRect.width) / pageRect.width;
    const sy =
      (page.container.offsetHeight || pageRect.height) / pageRect.height;
    for (const candidate of candidates) {
      const range = makeRange(doc, segments, candidate.start, candidate.end);
      if (!range) continue;
      const position = `${candidate.start}:${candidate.end}`;
      const known = this.vocabulary[candidate.lemma]?.state === "known";
      const marked = byPosition.has(position) && !known;
      page.hits.push({
        candidate,
        range,
        page,
        // Only the dotted candidates are contextual gloss targets. Other tokens
        // remain hoverable for side-button marking but must not start a request.
        glossable: marked,
        prefetch: marked,
      });
      if (!marked) continue;
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        const marker = doc.createElement("span");
        marker.style.cssText = `position:absolute;left:${(rect.left - pageRect.left) * sx}px;top:${(rect.bottom - pageRect.top) * sy - 1}px;width:${rect.width * sx}px;border-bottom:1px dotted #56877c;opacity:.75;`;
        overlay.append(marker);
      }
    }
    page.container.append(overlay);
  }

  hitAt(event) {
    for (const page of this.pages.values()) {
      if (!page.container.contains(event.target)) continue;
      return page.hits?.find((hit) =>
        [...hit.range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        ),
      );
    }
    return null;
  }

  handlePointer(event) {
    if (this.disposed || event.buttons || event.target?.closest?.(EDITABLE)) {
      this.closeGloss();
      return;
    }
    const selection = event.target?.ownerDocument?.getSelection?.();
    if (selection && !selection.isCollapsed) {
      this.closeGloss();
      return;
    }
    const hit = this.hitAt(event);
    if (this.hover === hit) return;
    this.closeGloss();
    this.hover = hit;
    if (
      !hit ||
      hit.glossable === false ||
      this.vocabulary[hit.candidate.lemma]?.state === "known"
    )
      return;
    const delay = Math.max(100, Number(this.getSettings().hoverDelay) || 120);
    this.timer = setTimeout(() => this.showGloss(hit), delay);
  }

  handleMouseSideButton(event) {
    if (
      this.disposed ||
      ![3, 4].includes(event.button) ||
      event.target?.closest?.(EDITABLE)
    )
      return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    const status = sideButtonStatus(event.button, this.getSettings());
    // Resolve coordinates again: never mark a stale hover after scrolling or rerendering.
    const hit = this.hitAt(event);
    if (!status || !hit) return false;
    this.setWordStatus(hit.candidate.lemma, status).catch((error) =>
      this.onChange({
        type: "error",
        message: `词汇状态保存失败：${error.message}`,
      }),
    );
    return true;
  }

  renderGlossCard(hit, message) {
    if (this.disposed || this.hover !== hit) return;
    if (this.card) {
      this.card.textContent = message;
      return;
    }
    const rect = hit.range.getBoundingClientRect();
    const doc = hit.page.container.ownerDocument;
    const card = doc.createElement("div");
    card.dataset.readerdWordOwned = "gloss";
    card.setAttribute("role", "tooltip");
    card.textContent = message;
    const win = doc.defaultView;
    const left = Math.max(
      8,
      Math.min(rect.left, (win?.innerWidth || 1000) - 290),
    );
    card.style.cssText = `position:fixed;left:${left}px;top:${Math.max(8, rect.top - 34)}px;max-width:280px;padding:5px 9px;background:rgba(250,249,246,.97);color:#244136;border-radius:4px;font:13px/20px system-ui;z-index:100;pointer-events:none;`;
    doc.body.append(card);
    this.card = card;
  }

  async showGloss(hit) {
    if (this.disposed || this.hover !== hit || hit.glossable === false) return;
    const sequence = ++this.sequence;
    const key = this.glossKey(hit.candidate);
    let result = this.cache.get(key);
    if (!result && this.aiEnabled()) this.renderGlossCard(hit, "释义加载中…");
    try {
      // A hover can join an in-flight background batch instead of starting a
      // second request for the same word and sentence.
      if (!result && this.pending.has(key)) {
        const pending = this.pending.get(key);
        const raw = await pending;
        result = this.normalizeGloss(raw);
        if (result) this.rememberGloss(key, result);
        else if (this.pending.get(key) === pending) this.pending.delete(key);
      }
      if (!result && this.requestGloss) {
        if (!this.pending.has(key)) {
          const request = Promise.resolve().then(() =>
            this.requestGloss(hit.candidate),
          );
          this.pending.set(key, request);
          request
            .finally(() => {
              if (this.pending.get(key) === request) this.pending.delete(key);
            })
            .catch(() => {});
        }
        const raw = await this.pending.get(key);
        result = this.normalizeGloss(raw);
        if (result) this.rememberGloss(key, result);
      }
      if (this.disposed || this.hover !== hit || this.sequence !== sequence)
        return;
      const message =
        result?.gloss ||
        (this.aiEnabled()
          ? "暂未获取到释义，稍后再试"
          : "配置模型后可显示上下文释义");
      this.renderGlossCard(hit, message);
      this.onChange({
        type: "gloss",
        word: hit.candidate.lemma,
        gloss: message,
      });
    } catch (error) {
      if (this.hover === hit && !this.disposed) {
        this.renderGlossCard(hit, "释义暂不可用");
        this.onChange({
          type: "error",
          message: `上下文释义暂不可用：${error.message}`,
        });
      }
    }
  }

  closeGloss() {
    clearTimeout(this.timer);
    this.sequence++;
    this.hover = null;
    this.card?.remove();
    this.card = null;
  }

  detachPage(pageNumber) {
    const page = this.pages.get(
      typeof pageNumber === "object" ? pageNumber.pageNumber : pageNumber,
    );
    if (!page) return;
    if (this.hover?.page === page) this.closeGloss();
    clearTimeout(page.prefetchScheduled);
    page.prefetchScheduled = null;
    page.overlay?.remove();
    for (const cleanup of page.cleanup) cleanup();
    this.pages.delete(page.pageNumber);
  }

  destroy() {
    this.disposed = true;
    this.stopPrefetch();
    this.closeGloss();
    for (const pageNumber of [...this.pages.keys()])
      this.detachPage(pageNumber);
    this.prefetchQueued.clear();
    this.cache.clear();
  }
}

export default WordCompanion;
