"""Record monster stat changes between two NiaDB fetches.

Compares data/reference/niadb/monsters.json with the copy at an earlier git
revision and appends what changed to data/reference/niadb/mob-changes.json,
which import_catalog loads for the "recent changes" on monster pages.

    python tools/niadb_mob_changes.py --base 49693457 --since 2026-11-03 --seen 2026-11-19

--base: the commit holding the previous fetch; --since: the day of that fetch;
--seen: the day of the new fetch. Earlier records stay; a rerun for the same
--seen replaces that day's records.
"""

import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MONSTERS = "data/reference/niadb/monsters.json"
OUTPUT = ROOT / "data/reference/niadb/mob-changes.json"
# NiaDB field -> the stat key on monster pages (mobs table column).
FIELDS = {
    "level": "level",
    "hp": "hp",
    "mp": "mp",
    "exp": "exp",
    "pdmg": "pad",
    "pdef": "pdd",
    "mdmg": "mad",
    "mdef": "mdd",
    "acc": "acc",
    "avoid": "eva",
}


def by_id(monsters):
    return {int(m["id"]): m for m in monsters}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--base", required=True, help="git revision with the previous monsters.json")
    parser.add_argument("--since", required=True, help="date of the previous fetch (YYYY-MM-DD)")
    parser.add_argument("--seen", required=True, help="date of the current fetch (YYYY-MM-DD)")
    args = parser.parse_args()

    old = by_id(json.loads(subprocess.check_output(["git", "show", f"{args.base}:{MONSTERS}"], cwd=ROOT)))
    new = by_id(json.loads((ROOT / MONSTERS).read_text(encoding="utf-8")))
    found = []
    for mob_id in sorted(new.keys() & old.keys()):
        for field, stat in FIELDS.items():
            before, after = old[mob_id].get(field), new[mob_id].get(field)
            if isinstance(before, int) and isinstance(after, int) and before != after:
                found.append({"mob_id": mob_id, "stat": stat, "from": before, "to": after,
                              "since": args.since, "seen": args.seen})

    kept = []
    if OUTPUT.exists():
        kept = [c for c in json.loads(OUTPUT.read_text(encoding="utf-8"))["changes"] if c["seen"] != args.seen]
    changes = sorted(kept + found, key=lambda c: (c["seen"], c["mob_id"], list(FIELDS.values()).index(c["stat"])))
    OUTPUT.write_text(json.dumps({
        "note": "Monster stat changes between NiaDB fetches, written by tools/niadb_mob_changes.py: "
                "the stat went from `from` to `to` some time between `since` and `seen`.",
        "changes": changes,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(found)} changes on {len({c['mob_id'] for c in found})} monsters ({len(changes)} kept in {OUTPUT.name})")


if __name__ == "__main__":
    main()
