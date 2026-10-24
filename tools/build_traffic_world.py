"""Build the public-domain, local SVG map used by the traffic page."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

REVISION = "9380cca83db5f9aef52d5e762765100745f84b27"
SOURCE = f"https://raw.githubusercontent.com/nvkelso/natural-earth-vector/{REVISION}/geojson/ne_110m_admin_0_countries.geojson"


def simplify(points, tolerance=0.3):
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    def distance(p):
        t = max(0, min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx+dy*dy))) if dx or dy else 0
        return ((p[0]-a[0]-t*dx)**2 + (p[1]-a[1]-t*dy)**2)**0.5
    i = max(range(1, len(points)-1), key=lambda i: distance(points[i]))
    if distance(points[i]) <= tolerance:
        return [a, b]
    return simplify(points[:i+1], tolerance)[:-1] + simplify(points[i:], tolerance)


def xy(lon, lat):
    return round((lon + 180) * 2, 1), round((85 - lat) * 2, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    raw = args.source.read_bytes() if args.source else urllib.request.urlopen(SOURCE).read()
    features = json.loads(raw)["features"]
    countries = []
    for feature in features:
        props, geometry = feature["properties"], feature["geometry"]
        code = props["ISO_A2_EH"]
        if code == "AQ":
            continue
        if code == "-99":
            code = "XK" if props["ADM0_A3"] == "KOS" else props["ADM0_A3"]
        code = {"CYN":"CY", "SOL":"SO"}.get(code, code)
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        segments = []
        for polygon in polygons:
            for ring in polygon:
                points = simplify(ring)
                if len(points) < 4:
                    continue
                segments.append("M" + "L".join(f"{x:g},{y:g}" for x, y in map(lambda p: xy(*p), points)) + "Z")
        x, y = xy(props["LABEL_X"], props["LABEL_Y"])
        countries.append({"code": code, "d": "".join(segments), "x": x, "y": y})
    # Small regions absent at 1:110m remain visible as location markers.
    for code, lon, lat in [("SG",103.82,1.35),("HK",114.17,22.3),("MO",113.55,22.2)]:
        x, y = xy(lon, lat)
        countries.append({"code":code,"d":"","x":x,"y":y})
    merged = {}
    for country in countries:
        if country["code"] in merged:
            merged[country["code"]]["d"] += country["d"]
        else:
            merged[country["code"]] = country
    countries = list(merged.values())
    target = Path(__file__).resolve().parents[1] / "web/data/traffic-world.json"
    target.write_text(json.dumps({"source":SOURCE,"sha256":hashlib.sha256(raw).hexdigest(),"countries":countries}, separators=(",", ":")), encoding="utf-8")
    print(f"{len(countries)} regions; {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
