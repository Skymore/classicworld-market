#!/usr/bin/env python3
"""Convert NiaDB's public maps bundle into the portal JSON that
`import_portals` reads (same shape as `market_map_resources.py` output).

    python3 tools/niadb_portals.py data/reference/niadb/maps.json \
        --output data/reference/niadb/portals.json

NiaDB (meowdb.com) extracted these fields from the client's Map.wz; portal
names such as out00 / east00, types and coordinates are the WZ values. We use
them until our own Map.wz export replaces them, then diff the two.
"""
import argparse
import json

# Scripted portals (WZ pt 8, tm 999999999: the script picks the target), so
# NiaDB lists no target for them. Targets are the pair the other side names
# (its portal's tm/tn point back here). Checked in the client's Map.wz on
# 2026-11-19. Players stand on them and press up, like a hidden portal.
CLIENT_SCRIPTED = [
    # The Tree Tunnel At the Forest Up North -> Forgotten Entrance III (east00)
    {"map_id": 10002071, "pn": "down00", "tm": 10006060, "tn": "east00", "x": 27, "y": 1244},
    # Sleepy Dungeon V -> Forgotten Dungeon Tunnel (top00)
    {"map_id": 10005054, "pn": "down00", "tm": 10006071, "tn": "top00", "x": 1047, "y": 2892},
]


def convert(maps):
    out = []
    for m in maps:
        portals = []
        for p in m.get("portals", []):
            to = p.get("toMapId")
            if not to:
                continue
            portals.append(
                {
                    "pn": p.get("name") or None,
                    "tm": int(to),
                    "tn": None,  # NiaDB does not publish the target portal name
                    "x": p.get("x"),
                    "y": p.get("y"),
                    # 1 hidden (stand on it and press up), 2 visible, 3 entered by touching it
                    "pt": p.get("type"),
                }
            )
        for extra in CLIENT_SCRIPTED:
            if extra["map_id"] == int(m["id"]) and not any(p["pn"] == extra["pn"] for p in portals):
                portals.append({k: v for k, v in extra.items() if k != "map_id"} | {"pt": 1})
        out.append({"map_id": int(m["id"]), "wz_version": None, "source": "niadb", "portals": portals})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("maps_json")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    maps = json.load(open(args.maps_json, encoding="utf-8"))
    converted = convert(maps)
    json.dump(converted, open(args.output, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    edges = sum(len(m["portals"]) for m in converted)
    print(f"maps {len(converted)}  portal edges {edges}")


if __name__ == "__main__":
    main()
