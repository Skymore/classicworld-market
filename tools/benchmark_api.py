"""Read-only latency sample of public API paths. No login or collector credentials."""
import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode


def paths(item):
    page = urlencode({"url": f"/item/{item}?hours=72"})
    return [
        "/readyz",
        *[f"/api/v1/contributors?period={p}" for p in ("week", "month", "all")],
        "/api/v1/market?view=list&hours=72",
        "/api/v1/market?view=list&hours=all",
        "/api/v1/market/records?kind=quotes&hours=72",
        "/api/v1/market/records?kind=sales&hours=72",
        "/api/v1/quotes/recent?hours=72",
        "/api/v1/sales/recent",
        f"/api/v1/sales/recent?item_id={item}",
        f"/api/v1/catalog/page?{page}",
        f"/api/v1/catalog/page?{page}&preview=true",
        f"/api/v1/item/{item}",
        f"/api/v1/items/{item}",
        "/api/v1/catalog/page?" + urlencode({"url": "/search?q=red"}),
        "/api/v1/account",
        f"/api/v1/watchlist/listings?ids={item}",
        "/api/v1/crafting/prices",
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8766")
    parser.add_argument("--item", type=int, default=2070001)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--output")
    args = parser.parse_args()
    results = []
    for path in paths(args.item):
        samples = []
        for _ in range(args.samples):
            started = time.perf_counter()
            request = urllib.request.Request(args.base.rstrip("/") + path, headers={"Accept-Encoding": "gzip"})
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    body = response.read()
                    status, timing = response.status, response.headers.get("Server-Timing")
            except urllib.error.HTTPError as error:
                body, status, timing = error.read(), error.code, error.headers.get("Server-Timing")
            except OSError as error:
                body, status, timing = b"", type(error).__name__, None
            samples.append({"ms": round((time.perf_counter()-started)*1000, 1),
                            "status": status, "bytes": len(body), "server_timing": timing})
        row = {"path": path, "median_ms": statistics.median(s["ms"] for s in samples),
               "max_ms": max(s["ms"] for s in samples), "samples": samples}
        results.append(row)
        print(json.dumps(row), flush=True)
    if args.output:
        from pathlib import Path
        Path(args.output).write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
