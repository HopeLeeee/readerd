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
const CACHE_LIMIT = 5000;
const PREFETCH_BATCH = 12;
const PREFETCH_LIMIT = 100;
const PREFETCH_CONCURRENCY = 6;

function abortError() {
  return new DOMException("Page was detached", "AbortError");
}

// Providers normally abort their transport too. Racing also releases readers
// immediately when an older provider ignores AbortSignal.
function withAbort(work, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw abortError();
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

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
    getDictionaryGloss = () => null,
    requestGloss,
    requestGlossBatch,
    onChange = () => {},
    loadState = async () => ({}),
    saveState = async () => {},
    loadGlossCache = async () => [],
    saveGlossCache = async () => {},
  } = {}) {
    Object.assign(this, {
      getSettings,
      getDictionaryGloss,
      requestGloss,
      requestGlossBatch,
      onChange,
      loadState,
      saveState,
      loadGlossCache,
      saveGlossCache,
    });
    this.vocabulary = Object.create(null);
    this.pages = new Map();
    this.cache = new Map();
    this.cacheRevision = 0;
    this.cacheSavedRevision = 0;
    this.cacheWrite = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.prefetchQueued = new Map();
    this.pendingOwners = new Map();
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
    const cached = await this.loadGlossCache().catch(() => []);
    if (!this.disposed && Array.isArray(cached)) {
      for (const entry of cached.slice(-CACHE_LIMIT)) {
        if (
          !Array.isArray(entry) ||
          typeof entry[0] !== "string" ||
          entry[0].length > 10000
        )
          continue;
        const result = this.normalizeGloss(entry[1]);
        if (result)
          this.cache.set(entry[0], {
            gloss: result.gloss,
            source: String(result.source || "cache").slice(0, 40),
          });
      }
    }
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
    return core.saneGloss(result?.gloss)
      ? { ...result, gloss: result.gloss.trim() }
      : null;
  }

  dictionaryFallback(hit) {
    if (hit.localFallback) return hit.localFallback;
    // Dictionary entries can legitimately contain several meanings. Keep them
    // separate from the stricter, single-context AI gloss validation and cache.
    try {
      const value = this.getDictionaryGloss(hit.candidate);
      hit.localFallback =
        typeof value === "string"
          ? value.replace(/\s+/g, " ").trim().slice(0, 200) || null
          : null;
    } catch {
      hit.localFallback = null;
    }
    return hit.localFallback;
  }

  pageSignal(page) {
    page.requestController ??= new AbortController();
    return page.requestController.signal;
  }

  cancelPageRequests(page) {
    page.requestController?.abort();
    for (const [key, owner] of this.pendingOwners) {
      if (owner !== page) continue;
      this.pending.delete(key);
      this.pendingOwners.delete(key);
    }
    for (const [key, owner] of this.prefetchQueued)
      if (owner === page) this.prefetchQueued.delete(key);
  }

  rememberGloss(key, result) {
    this.cache.delete(key);
    this.cache.set(key, { gloss: result.gloss, source: result.source || "ai" });
    this.cacheRevision++;
    this.scheduleCacheSave();
    while (this.cache.size > CACHE_LIMIT)
      this.cache.delete(this.cache.keys().next().value);
  }

  scheduleCacheSave(delay = 300) {
    if (this.cacheSaveTimer) return;
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = null;
      this.flushGlossCache().catch(() => {});
    }, delay);
    this.cacheSaveTimer.unref?.();
  }

  async flushGlossCache() {
    clearTimeout(this.cacheSaveTimer);
    this.cacheSaveTimer = null;
    if (this.cacheWrite) {
      await this.cacheWrite;
      if (this.cacheRevision !== this.cacheSavedRevision)
        return this.flushGlossCache();
      return;
    }
    this.cacheWrite = (async () => {
      while (this.cacheRevision !== this.cacheSavedRevision) {
        const revision = this.cacheRevision;
        await this.saveGlossCache([...this.cache]);
        this.cacheSavedRevision = revision;
      }
    })();
    try {
      await this.cacheWrite;
    } catch (error) {
      this.scheduleCacheSave(1000);
      throw error;
    } finally {
      this.cacheWrite = null;
    }
  }

  isPageNear(page) {
    if (this.isPageVisible(page)) return true;
    const rect = page.container?.getBoundingClientRect?.();
    const win = page.container?.ownerDocument?.defaultView;
    return !!(
      rect &&
      win &&
      rect.bottom > -win.innerHeight &&
      rect.top < win.innerHeight * 2 &&
      rect.right > 0 &&
      rect.left < win.innerWidth
    );
  }

  prefetchPriority(page) {
    if (this.isPageVisible(page)) return 0;
    return 1;
  }

  prioritizedHits(page) {
    const height =
      page.container?.ownerDocument?.defaultView?.innerHeight || 800;
    const priority = (hit) => {
      const rect = hit.range?.getBoundingClientRect?.();
      if (!rect || !Number.isFinite(rect.top)) return [3, 0];
      return [
        rect.top >= 0 && rect.top < height / 2
          ? 0
          : rect.top >= 0 && rect.top < height
            ? 1
            : 2,
        rect.top,
      ];
    };
    return [...(page.hits || [])].sort((a, b) => {
      const pa = priority(a),
        pb = priority(b);
      return (
        pa[0] - pb[0] ||
        pa[1] - pb[1] ||
        (a.candidate.start || 0) - (b.candidate.start || 0)
      );
    });
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

  /** Warm rendered pages up to one viewport ahead of reading. */
  schedulePrefetch(page) {
    if (this.disposed || this.prefetchStopped || page.prefetchScheduled) return;
    if (!this.requestGlossBatch || !this.aiEnabled() || !this.isPageNear(page))
      return;
    const delay = 60;
    page.prefetchScheduled = setTimeout(() => {
      page.prefetchScheduled = null;
      this.prefetchPage(page).catch(() => {});
    }, delay);
  }

  drainPrefetchSlots() {
    this.prefetchWaiting.sort(
      (a, b) => this.prefetchPriority(a.page) - this.prefetchPriority(b.page),
    );
    while (
      this.prefetchActive < PREFETCH_CONCURRENCY &&
      this.prefetchWaiting.length
    ) {
      // Leave room for the page being read when only neighbouring pages are ready.
      const index = this.prefetchWaiting.findIndex(
        (waiting) =>
          this.prefetchPriority(waiting.page) === 0 || this.prefetchActive < 2,
      );
      if (index < 0) break;
      this.prefetchWaiting.splice(index, 1)[0].start();
    }
  }

  acquirePrefetchSlot(signal, page) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiting = { start: null, page };
      const abortWaiting = () => {
        const index = this.prefetchWaiting.indexOf(waiting);
        if (index >= 0) this.prefetchWaiting.splice(index, 1);
        reject(abortError());
      };
      waiting.start = () => {
        signal.removeEventListener("abort", abortWaiting);
        if (signal.aborted) return reject(abortError());
        this.prefetchActive++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          signal.removeEventListener("abort", release);
          this.prefetchActive--;
          this.drainPrefetchSlots();
        };
        signal.addEventListener("abort", release, { once: true });
        resolve(release);
      };
      this.prefetchWaiting.push(waiting);
      signal.addEventListener("abort", abortWaiting, { once: true });
      queueMicrotask(() => this.drainPrefetchSlots());
    });
  }

  clearPrefetchGroup(group, page) {
    for (const candidate of group)
      if (this.prefetchQueued.get(this.glossKey(candidate)) === page)
        this.prefetchQueued.delete(this.glossKey(candidate));
  }

  async runPrefetch(group, page) {
    const signal = this.pageSignal(page);
    let release;
    try {
      release = await this.acquirePrefetchSlot(signal, page);
      if (this.disposed || this.prefetchStopped) {
        return;
      }
      // A detached or re-rendered page must not keep prefetching.
      if (this.pages.get(page.pageNumber) !== page) {
        return;
      }
      await this.prefetchGroup(group, page);
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    } finally {
      release?.();
      this.clearPrefetchGroup(group, page);
    }
  }

  async prefetchPage(target) {
    const page =
      typeof target === "object" ? target : this.pages.get(Number(target));
    if (!page || this.disposed || this.prefetchStopped) return;
    if (this.pageSignal(page).aborted) return;
    if (!this.requestGlossBatch || !this.aiEnabled() || !this.isPageNear(page))
      return;
    if (Date.now() < this.prefetchPausedUntil) return;
    const groups = [];
    let group = [];
    // The page cap applies before cache filtering, so repeated scroll events
    // cannot grow this into unrestricted whole-document translation.
    const targets = this.prioritizedHits(page)
      .filter(
        (hit) =>
          hit.prefetch &&
          this.vocabulary[hit.candidate.lemma]?.state !== "known",
      )
      .slice(0, PREFETCH_LIMIT);
    for (const hit of targets) {
      const candidate = hit.candidate;
      const key = this.glossKey(candidate);
      if (
        this.cache.has(key) ||
        this.pending.has(key) ||
        this.prefetchQueued.has(key) ||
        !candidate.sentence
      )
        continue;
      group.push(candidate);
      this.prefetchQueued.set(key, page);
      if (group.length === PREFETCH_BATCH) {
        groups.push(group);
        group = [];
      }
    }
    if (group.length) groups.push(group);
    const jobs = [];
    for (const group of groups) jobs.push(this.runPrefetch(group, page));
    // Adjacent targets share a request while retaining their individual sentence
    // context. Global priority and concurrency leave room for visible text.
    return Promise.allSettled(jobs);
  }

  async prefetchGroup(candidates, page) {
    const signal = this.pageSignal(page);
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
          raw = await withAbort(
            () => this.requestGlossBatch(fresh, { signal }),
            signal,
          );
        } catch (error) {
          if (error.name !== "AbortError") this.notePrefetchFailure();
          return new Map();
        }
        if (signal.aborted) return new Map();
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
        this.pendingOwners.set(key, page);
        result
          .finally(() => {
            if (this.pending.get(key) === result) {
              this.pending.delete(key);
              this.pendingOwners.delete(key);
            }
          })
          .catch(() => {});
      }
      await batch;
    } finally {
      for (const key of keys)
        if (this.prefetchQueued.get(key) === page)
          this.prefetchQueued.delete(key);
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
      this.cancelPageRequests(page);
    }
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
    if (
      this.cache.has(this.glossKey(hit.candidate)) ||
      this.dictionaryFallback(hit)
    ) {
      this.showGloss(hit);
      return;
    }
    const delay = Math.max(0, Number(this.getSettings().hoverDelay) || 60);
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
    const signal = this.pageSignal(hit.page);
    const key = this.glossKey(hit.candidate);
    let result = this.cache.get(key);
    const fallback = this.dictionaryFallback(hit);
    if (!result && fallback) this.renderGlossCard(hit, `词典参考：${fallback}`);
    else if (!result && this.aiEnabled())
      this.renderGlossCard(hit, "释义加载中…");
    try {
      // A hover can join an in-flight background batch instead of starting a
      // second request for the same word and sentence.
      if (!result && this.pending.has(key)) {
        const pending = this.pending.get(key);
        const raw = await pending;
        if (signal.aborted) return;
        result = this.normalizeGloss(raw);
        if (result) this.rememberGloss(key, result);
        else if (this.pending.get(key) === pending) this.pending.delete(key);
      }
      if (!result && this.requestGloss) {
        if (!this.pending.has(key)) {
          const request = withAbort(
            () => this.requestGloss(hit.candidate, { signal }),
            signal,
          );
          this.pending.set(key, request);
          this.pendingOwners.set(key, hit.page);
          request
            .finally(() => {
              if (this.pending.get(key) === request) {
                this.pending.delete(key);
                this.pendingOwners.delete(key);
              }
            })
            .catch(() => {});
        }
        const raw = await this.pending.get(key);
        if (signal.aborted) return;
        result = this.normalizeGloss(raw);
        if (result) this.rememberGloss(key, result);
      }
      if (this.disposed || this.hover !== hit || this.sequence !== sequence)
        return;
      const message =
        (result?.gloss &&
          (fallback ? `上下文：${result.gloss}` : result.gloss)) ||
        (fallback && `词典参考：${fallback}`) ||
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
      if (
        !signal.aborted &&
        this.hover === hit &&
        this.sequence === sequence &&
        !this.disposed
      ) {
        this.renderGlossCard(
          hit,
          fallback ? `词典参考：${fallback}` : "释义暂不可用",
        );
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
    this.cancelPageRequests(page);
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
    if (this.cacheRevision !== this.cacheSavedRevision)
      this.flushGlossCache().catch(() => {});
    else this.cache.clear();
  }
}

export default WordCompanion;
