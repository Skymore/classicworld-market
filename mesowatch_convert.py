"""Convert an authorized local MesoWatch snapshot into external reference JSON.

    python mesowatch_convert.py data/reference/mesowatch-market/<snapshot>

This is an offline preview, not an observations upload or a database importer.
Unknown native fields stay null. Source prices and their item/set units remain
explicit; source notices and original files are retained in the snapshot.
"""

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3


ROOT = Path(__file__).resolve().parent
SOURCE = "mesowatch"
HOW = {"found sold out": "found_sold", "stock dropped": "drop", "went grey on screen": "sold_out"}


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else None


def numeric_id(source_id):
    match = re.fullmatch(r"(?:basil|cash):([0-9]{8})", source_id)
    if not match or not 1_000_000 <= int(match[1]) <= 5_999_999:
        raise ValueError(f"Unsupported source item ID: {source_id}")
    return int(match[1])


def normalized_name(value):
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def mapping_status(item, catalog):
    local = catalog.get(numeric_id(item["id"]))
    if local is None:
        return "missing_id"
    return ("same_id_and_name" if normalized_name(local["name_en"]) ==
            normalized_name(item["name"]) else "same_id_different_name")


def category(item_id):
    return {1: "装备", 2: "消耗品", 3: "装饰", 4: "其他", 5: "商城物品"}[item_id // 1_000_000]


def convert_product(item, local):
    unit = item.get("unitBasis")
    if unit not in ("item", "set"):
        raise ValueError(f"Unsupported price unit: {unit}")
    basis = item.get("priceBasis")
    return {
        "world": "ClassicWorld", "item_id": numeric_id(item["id"]),
        "name_zh": local["name_zh"], "name_en": local["name_en"],
        "category": category(numeric_id(item["id"])),
        "source": SOURCE, "source_item_id": item["id"], "external": True,
        "unit_basis": unit, "requires_set_price_support": unit == "set",
        "typical": item.get("price"), "typical_low": item.get("p25"),
        "typical_high": item.get("p75"),
        "typical_basis": {"24h": "24h", "last10": "recent"}.get(basis),
        "typical_count": item.get("priceSales"), "low_data": item.get("lowData"),
        "median": item.get("askMedian"),
        # Historical sale extremes / cumulative ask counts are not live supply.
        "low": None, "high": None, "listings": None, "shops": None,
        "sales_24h": item.get("priceSales") if basis == "24h" else (0 if item.get("sold") == 0 else None),
        "sales_prev_24h": None, "sales_10d": None,
        "change_24h": round(item["trend"] * 100, 1) if item.get("trend") is not None else None,
        "last_sale_at": timestamp(item.get("lastSold")), "last_sale_price": None,
        "last3_avg": (item.get("last3") or {}).get("avg"),
        "last_seen": max(filter(lambda x: x is not None,
                                [timestamp(item.get("listedLast")), timestamp(item.get("lastSold"))]), default=None),
        "trend": [p["median"] for p in item.get("history", [])],
        "trend_dates": [p["date"] for p in item.get("history", [])],
        "trend_basis": "utc_calendar_day", "variant_count": None,
        "fast_price": None, "recommendation": None,
        "source_metrics": {key: item.get(key) for key in (
            "sold", "asks", "listingShops", "priceAll", "priceBasis", "trend",
            "low", "high", "sellThrough", "scrolled", "scrolledOnly")},
    }


def convert_sale(sale, item):
    unit = item["unitBasis"]
    return {
        "id": f"{SOURCE}:{item['id']}:{sale['id']}", "source": SOURCE,
        "source_sale_id": sale["id"], "source_item_id": item["id"],
        "item_id": numeric_id(item["id"]), "time": timestamp(sale["time"]),
        "kind": HOW.get(sale.get("how")), "shop": sale.get("seller"),
        "location": sale.get("location"), "external": True,
        "reference_price": sale["price"], "unit_basis": unit,
        "sale_unit_price": sale["price"] if unit == "item" else None,
        # Export qty is not proof of how many items sold or the original bundle.
        "sale_price": None, "bundle": None, "quantity": None, "previous_time": None,
        "source_qty": sale.get("qty"), "source_how": sale.get("how"),
        "equipment": None, "variant": "unknown" if numeric_id(item["id"]) // 1_000_000 == 1 else "standard",
    }


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def convert_snapshot(snapshot, catalog_path, output):
    snapshot, output = Path(snapshot), Path(output)
    doc = json.loads((snapshot / "list.json").read_text(encoding="utf-8"))
    if doc.get("kind") != "list" or doc.get("market") != "Classic World" or doc.get("preview") is not False:
        raise ValueError("Expected a published Classic World list snapshot")
    items = {item["id"]: item for item in doc["items"]}
    if len(items) != len(doc["items"]):
        raise ValueError("Duplicate source item IDs")
    with closing(sqlite3.connect(Path(catalog_path).resolve().as_uri() + "?mode=ro", uri=True)) as con:
        catalog = {row[0]: {"name_en": row[1], "name_zh": row[2]}
                   for row in con.execute("SELECT item_id,name_en,name_zh FROM items")}

    products, review, statuses = {}, [], Counter()
    for item in items.values():
        status = mapping_status(item, catalog)
        statuses[status] += 1
        iid = numeric_id(item["id"])
        if status == "same_id_and_name":
            products[item["id"]] = convert_product(item, catalog[iid])
        else:
            review.append({"source_item_id": item["id"], "candidate_item_id": iid,
                           "source_name": item["name"], "local": catalog.get(iid), "reason": status})

    documents = [(snapshot / "list.json", doc)]
    recent = snapshot / "recent.json"
    if recent.exists():
        documents.append((recent, json.loads(recent.read_text(encoding="utf-8"))))
    for path in sorted((snapshot / "items").glob("*.json")):
        documents.append((path, json.loads(path.read_text(encoding="utf-8"))))
    exports = {data["generated_at"] for _, data in documents}
    if len(exports) != 1 or any(data.get("market") != doc["market"] for _, data in documents):
        raise ValueError("Mixed market/export snapshots; fetch a consistent set before converting")

    sales = {}
    for _, data in documents[1:]:
        for sale in data.get("sales", []):
            source_id = sale.get("itemId", data.get("id"))
            if source_id in products:
                converted = convert_sale(sale, items[source_id])
                if converted["id"] in sales and sales[converted["id"]] != converted:
                    raise ValueError(f"Conflicting source sale: {converted['id']}")
                sales[converted["id"]] = converted
    ordered_sales = sorted(sales.values(), key=lambda s: (s["time"], s["id"]), reverse=True)
    for sale in ordered_sales:
        product = products[sale["source_item_id"]]
        if product["last_sale_at"] == sale["time"] and product["last_sale_price"] is None:
            product["last_sale_price"] = sale["reference_price"]

    output.mkdir(parents=True, exist_ok=True)
    header = {"schema_version": 1, "mode": "external_reference_preview", "source": SOURCE,
              "source_market": doc["market"], "source_generated_at": doc["generated_at"],
              "generated_at": datetime.now(timezone.utc).timestamp(), "production_imported": False,
              "notice": doc.get("notice"), "terms": doc.get("terms"),
              "limitation": "External reference only; unknown snapshot, inventory and bundle fields remain null. Set prices require explicit UI support. UTC daily history differs from our rolling buckets."}
    write_json(output / "quotes-reference.json", dict(header, products=list(products.values())))
    write_json(output / "sales-reference.json", dict(header, sales=ordered_sales))
    write_json(output / "mapping-review.json", review)
    files = [{"path": path.relative_to(snapshot).as_posix(), "bytes": path.stat().st_size,
              "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
              "source_url": "https://meso.watch/data/list.json" if path.name == "list.json" else
              "https://meso.watch/data/markets/Classic%20World/" +
              ("item/" + path.name if path.parent.name == "items" else path.name)} for path, _ in documents]
    summary = {"source_generated_at": doc["generated_at"], "items": len(items),
               "priced_items": sum(i.get("price") is not None for i in items.values()),
               "source_total_sale_records": doc["totals"]["sales"],
               "sum_item_sale_counts": sum(i.get("sold", 0) for i in items.values()),
               "recent_sale_records": len(documents[1][1].get("sales", [])) if recent.exists() else 0,
               "item_detail_files": sum(p.parent.name == "items" for p, _ in documents),
               "item_detail_sale_records": sum(len(d.get("sales", [])) for p, d in documents if p.parent.name == "items"),
               "mapping": dict(statuses), "converted_products": len(products),
               "converted_unique_sales": len(ordered_sales),
               "set_priced_products": sum(p["unit_basis"] == "set" for p in products.values()),
               "categories": dict(Counter(i["category"] for i in items.values())),
               "files": files}
    write_json(output / "inspection.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--catalog", type=Path, default=ROOT / "item_database/items.sqlite")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = convert_snapshot(args.snapshot, args.catalog, args.output or args.snapshot / "converted")
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
