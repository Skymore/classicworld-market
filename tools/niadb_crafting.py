"""Normalize NiaDB's public crafting page into the website's recipe snapshot.

Usage: python tools/niadb_crafting.py PAGE.html --output web/data/crafting.json
Only crafting facts and exact Classic World icon IDs are retained. Prices are
read from our own market at runtime, never copied from another price tracker.
"""
import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import re

SOURCE = "https://meowdb.com/msclassic/crafting"


def crafting_props(value):
    if isinstance(value, dict):
        if "disciplines" in value and "itemIconLookup" in value:
            return value
        children = value.values()
    elif isinstance(value, list):
        children = value
    else:
        return None
    for child in children:
        found = crafting_props(child)
        if found is not None:
            return found
    return None


def parse_page(text):
    flight = []
    for raw in re.findall(r'self\.__next_f\.push\((\[.*?\])\)</script>', text):
        value = json.loads(raw)
        if len(value) > 1 and isinstance(value[1], str):
            flight.append(value[1])
    for line in "".join(flight).splitlines():
        try:
            value = json.loads(line.split(":", 1)[1])
        except (ValueError, IndexError):
            continue
        found = crafting_props(value)
        if found is not None:
            return found
    raise ValueError("The public page has no recognized crafting data")


def normalize(props, checked_on, sha256):
    items, recipes = {}, []

    def item(name, explicit_id=None):
        item_id = int(props["itemIconLookup"].get(name, explicit_id))
        if explicit_id is not None and item_id != explicit_id:
            raise ValueError(f"Conflicting Classic World ID for {name}")
        if not 1_000_000 <= item_id < 6_000_000:
            raise ValueError(f"Invalid item ID: {item_id}")
        items[str(item_id)] = {"name_en": name, "niadb_id": props["itemIdLookup"].get(name)}
        return item_id

    for discipline in props["disciplines"]:
        for kind in discipline["output_types"]:
            for level in kind["levels"]:
                for row in level["recipes"]:
                    output = item(row["result_item_name"], row["output_id"])
                    ingredients = [{"item_id": item(i["item_name"]), "quantity": i["count"]} for i in row["ingredients"]]
                    catalyst = row.get("catalyst")
                    if catalyst:
                        catalyst = {"item_id": item(catalyst["name"], catalyst["item_id"]), "quantity": catalyst["count"]}
                    recipe = dict(id=f"{discipline['skill_id']}:{row['id']}", item_id=output,
                                  discipline=discipline["discipline"], level=row["req_level"],
                                  output_quantity=row["result_count"], fee=row["meso_cost"],
                                  exp=row["craft_exp"], ingredients=ingredients, catalyst=catalyst)
                    if recipe["fee"] < 0 or recipe["output_quantity"] <= 0 or any(i["quantity"] <= 0 for i in ingredients):
                        raise ValueError(f"Invalid recipe: {recipe['id']}")
                    recipes.append(recipe)
    if not recipes or len({r["id"] for r in recipes}) != len(recipes):
        raise ValueError("Missing or duplicated recipes")
    return dict(schema_version=1, source=SOURCE, checked_on=checked_on, source_sha256=sha256,
                version="NiaDB public recipe snapshot; in-game availability not independently verified",
                items=items, recipes=recipes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("page", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checked-on", default=date.today().isoformat())
    args = parser.parse_args()
    raw = args.page.read_bytes()
    catalog = normalize(parse_page(raw.decode("utf-8")), args.checked_on, hashlib.sha256(raw).hexdigest())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(catalog['recipes'])} recipes; {len(catalog['items'])} exact item IDs")


if __name__ == "__main__":
    main()
