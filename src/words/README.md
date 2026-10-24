# readerc integration

`readerc-core.js` is the unmodified portable logic from HopeLeeee/readerc
`addon/src/core.js` at commit `b3eff01dc649d2839f69a7f356d1e655e1956b46`,
with its CommonJS footer replaced by ES module exports. MIT attribution is in
`LICENSE.readerc.txt`. Source: https://github.com/HopeLeeee/readerc.

`companion.js` adapts the non-destructive range and overlay approach of readerc's
`reader.js` to standalone PDF.js. It does not load a Zotero XPI, depend on Gecko,
or directly share Zotero storage. ReaderC `known`/`unknown` vocabulary objects can
be imported through `loadState`.

The original 9.9 MB ReaderC ECDICT index is bundled locally in
`data/lexicon.json` with 363,525 ranked entries and 55,084 explicit word-form
mappings. Call `await loadLexicon()` (exported by `companion.js` or `lexicon.js`)
once, keep the result in memory, and supply it through `getSettings().lexicon`.
Do not serialize this index into user settings. Sources, checksums and licenses
are in `THIRD_PARTY_NOTICES.md`, `LICENSE.ECDICT.txt`, and `LICENSE.readerc.txt`.

The index enables ReaderC's original frequency threshold and explicit inflection
mapping, including biological English vocabulary. It does not contain Chinese
definitions; contextual glosses use the model callback. If the index cannot be
loaded, only built-in academic phrases and manual unknown words get automatic
dotted markers. Other English words can still be hovered and manually marked.

## Host contract

Construct `new WordCompanion({getSettings, requestGloss, onChange, loadState,
saveState})`, then `await initialize()`. All callbacks are optional.

- `getSettings()` returns `{enabled, hoverDelay, familiarButton:4,
unfamiliarButton:3, lexicon, threshold, firstOnly, maxPerPage, endpoint, model}`.
  Buttons 3 and 4 can be swapped; invalid or identical mappings disable marking.
- `loadState()` returns a vocabulary object or `{vocabulary}`.
- `saveState(vocabulary)` must persist before resolving. On failure local state
  remains unchanged. Operations are serialized to preserve concurrent edits.
- `requestGloss(candidate)` returns a string or `{gloss,source?}`. `candidate`
  has `word`, `lemma`, `sentence`, `targetStart`, `targetEnd`. Only bounded context
  is passed; the host owns network configuration and authentication. The
  portable core exports `requestBody` and `parseGloss` for readerc's protocol.
- `requestGlossBatch(candidates)` is optional. It receives candidates from one
  sentence and returns the model's raw JSON array string. When supplied, visible
  pages prefetch candidate glosses in small sentence batches; hovers then read the
  cache. Without it the adapter only requests on hover. `prefetchPage(pageNumber)`
  warms a page explicitly and `stopPrefetch()` cancels queued background work.
- `onChange(event)` emits `type:'status'|'gloss'|'error'`, with `message`, `word`,
  `status` and `gloss` as applicable. Status values are `known`/`unknown`.

After every PDF.js text-layer render, call `attachPage({pageNumber,container,
textLayer,items})`. The adapter attaches its own page-level pointer and mouse
listeners. `items` is reserved; indexing uses live text nodes. Do not additionally
forward events for attached pages. Call `detachPage(pageNumber)` before unmounting
and `destroy()` when replacing the document. After zoom, reattach rendered pages
so markers have fresh geometry. `handlePointer(event)` and
`handleMouseSideButton(event)` are exposed for testing/alternative hosts.

`setWordStatus(word,status)` accepts `known`/`unknown` or
`familiar`/`unfamiliar`. No marking happens without a word at the pointer.
Selection/copy stays with PDF.js: text nodes are untouched and markers ignore
pointer input. Side-button navigation is suppressed within attached pages.
