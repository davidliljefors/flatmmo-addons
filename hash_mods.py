#!/usr/bin/env python3
"""
Rehash mods/index.json entries.

Computes a sha256 of each mod's entry file and writes it to that mod's "hash"
field in mods/index.json. Flat Mod Loader caches a mod's fetched script in
localStorage keyed by this hash, so it only re-downloads the file when the
hash actually changes (i.e. when you remember to run this script).

Usage (from the repo root):
    python hash_mods.py
"""
import hashlib
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(ROOT, "mods", "index.json")


def main():
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    changed = 0
    for mod in data["mods"]:
        entry_path = os.path.join(ROOT, mod["entry"])
        with open(entry_path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()[:12]
        if mod.get("hash") != digest:
            mod["hash"] = digest
            changed += 1
        else:
            mod["hash"] = digest

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print(f"Hashed {len(data['mods'])} mods, {changed} changed.")


if __name__ == "__main__":
    main()
