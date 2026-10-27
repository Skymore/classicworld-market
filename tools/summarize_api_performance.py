"""Summarize operational logs without exporting queries, bodies or identities."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import statistics

ANSI = re.compile(r"\x1b\[[0-9;]*m")
FIELD = re.compile(r'(\w+)=(?:"([^"\n]*)"|([^\s]+))')
CACHE_COUNTS = ("requests", "hits", "rebuilds", "collisions", "evictions", "bypasses",
                "cold", "expired", "invalidated")
CACHE_TIMES = ("lookup_ms", "wait_ms", "key_wait_ms", "permit_wait_ms", "build_ms")


def timing(values):
    if not values:
        return {"count": 0}
    values = sorted(values)
    return {"count": len(values), "median_ms": round(statistics.median(values), 2),
            "p95_ms": round(values[math.ceil(len(values) * .95) - 1], 2),
            "max_ms": round(values[-1], 2)}


def summarize(lines, since, until):
    lanes = defaultdict(Counter)
    routes = defaultdict(list)
    slow_per_minute = Counter()
    uploads, batches, rollbacks = 0, [], 0
    errors, sql_slow, pool_waits = 0, 0, 0
    largest_batch = 0
    for raw in lines:
        line = ANSI.sub("", raw)
        try:
            at = datetime.fromisoformat(line.split()[0].replace("Z", "+00:00"))
        except (ValueError, IndexError):
            continue
        if at.tzinfo is None or not since <= at <= until:
            continue
        fields = {key: quoted or bare for key, quoted, bare in FIELD.findall(line)}
        if "public cache interval" in line and fields.get("lane") in ("item", "watch", "crafting"):
            lane = lanes[fields["lane"]]
            lane["intervals"] += 1
            for name in CACHE_COUNTS:
                if name in fields:
                    lane[name] += int(fields[name])
            for name in CACHE_TIMES:
                if name in fields:
                    lane[name] += float(fields[name])
                    divisor = "rebuilds" if name == "build_ms" else "requests"
                    lane[name + "_samples"] += int(fields[divisor])
            if "entries" in fields:
                lane["entries_max"] = max(lane["entries_max"], int(fields["entries"]))
            lane["cause_intervals"] += int("cold" in fields)
        if "slow API request" in line and fields.get("route", "").startswith("/api/"):
            # MatchedPath is a route template. Strip query strings defensively.
            route = fields["route"].split("?", 1)[0]
            routes[route].append(float(fields["elapsed_ms"]))
            slow_per_minute[at.astimezone(timezone.utc).isoformat()[:16]] += 1
        if "upload batch processed" in line:
            count = int(fields["uploads"])
            uploads += count
            largest_batch = max(largest_batch, count)
            batches.append(float(fields["elapsed_ms"]))
            rollbacks += fields.get("committed") != "true"
        errors += bool(re.search(r"\bERROR\b", line))
        sql_slow += "summary" in fields and "elapsed_secs" in fields
        pool_waits += "aquired_after_secs" in fields or "acquired_after_secs" in fields
    cache = {}
    for name, values in lanes.items():
        requests = values["requests"]
        row = {key: values.get(key) for key in ("intervals", "cause_intervals", *CACHE_COUNTS, "entries_max")}
        row["hit_percent"] = round(100 * values["hits"] / requests, 2) if requests else None
        for field in CACHE_TIMES:
            divisor = values[field + "_samples"]
            row["mean_" + field] = round(values[field] / divisor, 3) if divisor else None
        cache[name] = row
    return {"since": since.isoformat(), "until": until.isoformat(), "cache": cache,
            "slow_requests_only": {name: timing(values) for name, values in
                                   sorted(routes.items(), key=lambda entry: -sum(entry[1]))},
            "slow_requests_per_minute": dict(sorted(slow_per_minute.items())),
            "upload_batches": {**timing(batches), "uploads": uploads, "largest_batch": largest_batch,
                               "mean_batch_size": round(uploads / len(batches), 2) if batches else None,
                               "rolled_back": rollbacks},
            "error_log_count": errors, "slow_sql_log_count": sql_slow, "pool_wait_log_count": pool_waits}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, default=Path("shared_data/web.log"))
    window = parser.add_mutually_exclusive_group()
    window.add_argument("--minutes", type=float, default=15)
    window.add_argument("--since", help="Start time in ISO 8601 with time zone")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    until = datetime.now(timezone.utc)
    if args.since:
        try:
            since = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
        except ValueError:
            parser.error("since must be an ISO 8601 timestamp")
        if since.tzinfo is None:
            parser.error("since must include a time zone")
    else:
        if not 0 < args.minutes <= 7 * 24 * 60:
            parser.error("minutes must be between 0 and 10080")
        since = until - timedelta(minutes=args.minutes)
    with args.log.open(encoding="utf-8", errors="replace") as stream:
        result = summarize(stream, since, until)
    body = json.dumps(result, ensure_ascii=False, indent=2)
    print(body)
    if args.output:
        args.output.write_text(body + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
