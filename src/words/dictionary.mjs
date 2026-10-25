/** Offline dictionary senses. These are not context-specific model translations. */
const chinese = /[\u3400-\u9fff]/u;

function validDefinition(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && chinese.test(value);
}

/** Load once at startup, independently of any AI connection. */
export async function loadDictionary({ fetchImpl = globalThis.fetch, url = new URL("./data/definitions.json", import.meta.url) } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("词典加载需要 fetch。");
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`本地词典加载失败：${response.status}`);
  const dictionary = await response.json();
  if (!dictionary || !dictionary.entries || typeof dictionary.entries !== "object" || Array.isArray(dictionary.entries)) {
    throw new Error("本地词典格式无效。");
  }
  // Records are checked at lookup, keeping startup cheap even for a large dictionary.
  return dictionary;
}

function normalize(value) {
  return typeof value === "string"
    ? value.replace(/\u00ad(?:\s*\r?\n\s*)?/gu, "").replace(/-\s*\r?\n\s*/gu, "").replace(/\s+/gu, " ").trim().toLowerCase()
    : "";
}

/** Prefer the visible word/phrase, then a caller-provided inflection lemma. O(1). */
export function dictionaryGloss(candidate, dictionary) {
  const entries = dictionary?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
  const surface = typeof candidate === "string" ? candidate : candidate?.word ?? candidate?.surface;
  for (const raw of [surface, candidate?.lemma]) {
    const key = normalize(raw);
    if (key && Object.hasOwn(entries, key) && validDefinition(entries[key])) return entries[key];
  }
  return null;
}

export default loadDictionary;
