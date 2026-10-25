# Third-party notices

## ReaderC portable vocabulary logic and adapter design

- Project: https://github.com/HopeLeeee/readerc
- Revision: `b3eff01dc649d2839f69a7f356d1e655e1956b46`
- Files: `addon/src/core.js`, design adapted from `addon/src/reader.js`.
- License: MIT, copyright (c) 2026 HopeLeeee. See `LICENSE.readerc.txt`.

## Bundled ECDICT index

The bundled `data/lexicon.json` is the unchanged original index downloaded from
ReaderC at the above revision (`addon/data/lexicon.json`, Git blob
`b6b535409c49650ceebb11e72eefd8942095c336`).

- Download: https://raw.githubusercontent.com/HopeLeeee/readerc/b3eff01dc649d2839f69a7f356d1e655e1956b46/addon/data/lexicon.json
- Size: 9,933,972 bytes.
- SHA-256: `c481e1ae54893a54d4b9cbba568c19e37b8d21e3239a6f39c97479474340263a`.
- Project: https://github.com/skywind3000/ECDICT
- Pinned upstream revision: `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`.
- Original source file: `ecdict.csv`.
- License: MIT; complete upstream notice in `LICENSE.ECDICT.txt`.
- Source credit: skywind3000/ECDICT contributors; upstream notice credits Linwei (2025).
- ReaderC transformations: lowercase single-word filtering, inflection index,
  FRQ/BNC ranking and compact JSON representation. No CEFR-equivalence claim.
- Actual bundled JSON metadata specifies **no definitions bundled**: the index
  provides frequency ranks and word forms. Chinese dictionary senses are now
  bundled separately in `data/definitions.json` (see below); contextual Chinese
  glosses still require the user's configured model. The original ReaderC notice mentions
  definition truncation, but definitions are absent in this particular index.

The index contains 363,525 entries and 55,084 explicit inflection mappings.
Root fields are `meta`, `entries`, `forms`; each entry is `{rank:number}`;
`forms` maps an inflected lowercase term to its lemma. Rank 0 means unranked.

Zotero remains a separate application; its source code is not bundled.

## Bundled ECDICT Chinese dictionary senses

`data/definitions.json` contains genuine Chinese `translation` fields from the
same pinned upstream revision; no model-generated definitions are included.
It is used for immediate dictionary fallback, marked with a small red dot, while a
context-specific model translation is pending.

- Source: https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv
- License: MIT; see `LICENSE.ECDICT.txt`.
- Source size: 65,933,428 bytes.
- Source Git blob SHA-1: `c4ade63ea08cf39d9c3475e96929036d64d94c94`.
- Source SHA-256: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`.
- Output entries: 363,525; output size: 18,538,305 bytes.
- Output SHA-256: `fa1899e2cd58ff169d6d9db3d0be76c5e22ee36f80f7649c4aa97b467b060076`.
- Transformations: intersect lowercase source words with the existing lexicon;
  retain translations containing Chinese; replace literal `\\n` and whitespace
  runs with spaces; truncate to at most 200 Unicode characters. Multiple
  dictionary senses are preserved within that limit.
- Reproducible generator: `tools/build-definitions.py` verifies the pinned source
  size and Git blob hash before reading it. Run:

  ```text
  python tools/build-definitions.py --source .research/ecdict.csv --lexicon src/words/data/lexicon.json --output src/words/data/definitions.json
  ```

The 65 MB upstream CSV is an ignored build input and is not redistributed in
the application. The dictionary's senses are general meanings; the interface
must distinguish them from model translations based on the current sentence.
