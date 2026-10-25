"""Build the pinned ECDICT Chinese definitions used for immediate hover fallback.

python tools/build-definitions.py --source .research/ecdict.csv \
    --lexicon src/words/data/lexicon.json --output src/words/data/definitions.json
"""

import argparse
import csv
import hashlib
import json
import re
from pathlib import Path

REVISION = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
SOURCE_BLOB = "c4ade63ea08cf39d9c3475e96929036d64d94c94"
SOURCE_SIZE = 65933428


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "lexicon", "output"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    args = parser.parse_args()
    source = args.source.read_bytes()
    blob = hashlib.sha1(f"blob {len(source)}\0".encode() + source).hexdigest()
    if len(source) != SOURCE_SIZE or blob != SOURCE_BLOB:
        raise SystemExit(f"ECDICT source mismatch: size={len(source)}, blob={blob}")
    lexicon_bytes = args.lexicon.read_bytes()
    lexicon = json.loads(lexicon_bytes)
    entries = {}
    with args.source.open(encoding="utf-8", newline="") as stream:
        for row in csv.DictReader(stream):
            word = row["word"].strip().lower()
            if word not in lexicon["entries"]:
                continue
            translation = re.sub(r"\s+", " ", row["translation"].replace("\\n", " ")).strip()[:200]
            if re.search(r"[\u3400-\u9fff]", translation):
                entries[word] = translation
    meta = {
        "source": "ECDICT", "url": "https://github.com/skywind3000/ECDICT",
        "commit": REVISION, "license": "MIT", "sourceGitBlob": blob,
        "sourceSize": len(source), "sourceSHA256": hashlib.sha256(source).hexdigest(),
        "lexiconSHA256": hashlib.sha256(lexicon_bytes).hexdigest(),
        "entries": len(entries), "maxDefinitionCharacters": 200,
        "selection": "Existing lexicon entries with Chinese translation; whitespace collapsed; first 200 characters; dictionary senses, not contextual AI translations",
    }
    output = json.dumps({"meta": meta, "entries": dict(sorted(entries.items()))}, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(output)
    print(json.dumps({"entries": len(entries), "bytes": len(output), "sha256": hashlib.sha256(output).hexdigest(), "sourceGitBlob": blob}))


if __name__ == "__main__":
    main()
