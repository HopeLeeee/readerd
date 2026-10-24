/** Load readerc's original local ECDICT frequency and word-form index once per host. */
export async function loadLexicon({ fetchImpl = globalThis.fetch, url = new URL('./data/lexicon.json', import.meta.url) } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('词库加载需要 fetch。');
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`本地词库加载失败：${response.status}`);
  const lexicon = await response.json();
  if (!lexicon?.entries || typeof lexicon.entries !== 'object' || Array.isArray(lexicon.entries)
    || !lexicon.forms || typeof lexicon.forms !== 'object' || Array.isArray(lexicon.forms)) {
    throw new Error('本地词库格式无效。');
  }
  return lexicon;
}

export default loadLexicon;
