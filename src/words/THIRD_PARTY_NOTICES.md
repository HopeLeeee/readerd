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
  provides frequency ranks and word forms; contextual Chinese glosses still
  require the user's configured model. The original ReaderC notice mentions
  definition truncation, but definitions are absent in this particular index.

The index contains 363,525 entries and 55,084 explicit inflection mappings.
Root fields are `meta`, `entries`, `forms`; each entry is `{rank:number}`;
`forms` maps an inflected lowercase term to its lemma. Rank 0 means unranked.

Zotero remains a separate application; its source code is not bundled.
