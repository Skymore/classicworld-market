#!/usr/bin/env python3
"""Fetch NiaDB's (meowdb.com) MapleStory Classic item list into one file.

    python3 tools/niadb_items.py --output data/reference/niadb/items.json

The item-db page pages through `/msclassic/api/items?type=<tab>&page=<n>`;
the same endpoint takes `limit` (capped at 500 per page). We keep the API
objects unchanged. `iconKey` is the Classic World item id, `id` is NiaDB's own.
"""
import argparse
import json
import time
import urllib.parse
import urllib.request

API = "https://meowdb.com/msclassic/api/items"
TABS = ("Equip", "Use", "Setup", "Etc", "Cash")
PAGE_SIZE = 500
# Cloudflare in front of the site rejects urllib's default agent.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"


def fetch_page(tab, page):
    query = urllib.parse.urlencode({"type": tab, "limit": PAGE_SIZE, "page": page})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def fetch_all(pause):
    items = {}
    for tab in TABS:
        page = 1
        while True:
            data = fetch_page(tab, page)
            for item in data["items"]:
                items[item["id"]] = item
            print(f"{tab} page {page}: {len(data['items'])} items")
            if not data.get("hasMore"):
                break
            page += 1
            time.sleep(pause)
        time.sleep(pause)
    return sorted(items.values(), key=lambda item: item["id"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    ap.add_argument("--pause", type=float, default=1.0, help="seconds between requests")
    args = ap.parse_args()
    items = fetch_all(args.pause)
    with open(args.output, "w", encoding="utf-8") as out:
        json.dump(items, out, ensure_ascii=False, separators=(",", ":"))
        out.write("\n")
    print(f"items {len(items)}")


if __name__ == "__main__":
    main()
