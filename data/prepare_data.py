#!/usr/bin/env python3
"""Turn the raw Warsaw RCN GML export into a compact JSON the static frontend can filter in-browser.

Input : a TurboEWID RCN 1.4 GML dump for m.st. Warszawa (TERYT 1465), EPSG:2178.
Output: public/data/transactions.json  (slim columnar array of residential sales)
        public/data/districts.geojson  (the 18 dzielnice boundaries, WGS84)

The GML is a normalised, relational model. A single flat sale is spread across linked
objects joined by xlink:href -> gml:id, with references pointing both back and forward:

    RCN_Transakcja --podstawaPrawna--> RCN_Dokument   (transaction date)
                   --nieruchomosc---->  RCN_Nieruchomosc --lokal--> RCN_Lokal
                                                          --budynek--> RCN_Budynek
                                                          --dzialka--> RCN_Dzialka

Because references are unordered, we stream the whole file once to build id->object
lookups, then resolve every transaction in memory. See FILTERS below for what we keep.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path

from lxml import etree
from pyproj import Transformer
from shapely.geometry import Point, Polygon, mapping, shape

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
RAW_GML = ROOT / "data" / "RCN_20260526.gml"
DISTRICTS_SRC = ROOT / "data" / "warszawa-dzielnice.geojson"
OUT_TX = ROOT / "public" / "data" / "transactions.json"
OUT_DISTRICTS = ROOT / "public" / "data" / "districts.geojson"

CUTOFF = "2025-01-01"          # keep deeds on/after this date (user requirement #1)
SOURCE_EPSG = 2178             # PUWG 2000 zone 7, as declared in the GML srsName

# RCN_1.4 code dictionaries (from the official conceptual model, Annex 9)
RODZAJ_LOKALOWA = "4"          # rodzajNieruchomosci: nieruchomoscLokalowa  -> a flat
RODZAJ_GRUNT_ZABUDOWANA = "2"  # rodzajNieruchomosci: gruntowaZabudowana    -> a house+plot
FUNKCJA_MIESZKALNA = "1"       # funkcjaLokalu: mieszkalna                  -> residential
BUDYNEK_MIESZKALNY = "110"     # rodzajBudynku: mieszkalny                  -> residential building
# rodzajTransakcji we DROP (explicit non-market deals that distort prices):
#   2 bezprzetargowa, 3 przetargowa, 4 egzekucyjna, 5 celPubliczny, 6 zBonifikata.
# We keep 1 (wolnyRynek) and empty/unspecified.
TX_KIND_DROP = {"2", "3", "4", "5", "6"}

# Sanity gate (conservative): some kept (untyped) deals are clearly not arms-length
# market sales -- family/share transfers, cooperative conversions, data-entry errors.
# These bounds are deliberately wide; widen/disable here if you'd rather keep everything.
MIN_FLAT_AREA = 10.0        # m^2; drops storage-share "flats"
FLAT_PPM2_MIN = 3000        # zl/m^2; below this is almost never a real Warsaw sale
FLAT_PPM2_MAX = 80000       # zl/m^2; above this is data error / bulk
MIN_HOUSE_PRICE = 50000     # zl; drops token/share transfers

# XML namespaces
RCN = "{urn:gugik:specyfikacje:gmlas:rejestrcennieruchomosci:1.0}"
GML = "{http://www.opengis.net/gml/3.2}"
HREF = "{http://www.w3.org/1999/xlink}href"

transformer = Transformer.from_crs(SOURCE_EPSG, 4326, always_xy=True)


# ---------------------------------------------------------------------------
# Small XML helpers
# ---------------------------------------------------------------------------
def txt(el, local):
    """Direct child text by local name, or None."""
    c = el.find(RCN + local)
    return c.text.strip() if c is not None and c.text and c.text.strip() else None


def href(el, local):
    """xlink:href of a direct child reference element, or None."""
    c = el.find(RCN + local)
    return c.get(HREF) if c is not None else None


def hrefs(el, local):
    """All xlink:hrefs for a (possibly repeated) child reference element."""
    return [c.get(HREF) for c in el.findall(RCN + local) if c.get(HREF)]


def to_float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def to_int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


def first_poslist(geom_el):
    """Return list of (easting, northing) pairs from the first gml:posList/gml:pos found.

    GML pos for EPSG:2178 is "<northing> <easting>"; shapely wants (x=easting, y=northing),
    which is also what the always_xy transformer expects, so we swap here once.
    """
    if geom_el is None:
        return None
    node = geom_el.find(".//" + GML + "posList")
    if node is None:
        node = geom_el.find(".//" + GML + "pos")
    if node is None or not node.text:
        return None
    nums = [float(x) for x in node.text.split()]
    # pairs are (northing, easting) -> emit (easting, northing)
    return [(nums[i + 1], nums[i]) for i in range(0, len(nums) - 1, 2)]


def point_2178_to_wgs(easting, northing):
    lon, lat = transformer.transform(easting, northing)
    return round(lon, 6), round(lat, 6)


# ---------------------------------------------------------------------------
# Pass 1: stream the whole GML, collecting id -> object lookups
# ---------------------------------------------------------------------------
def build_lookups(path: Path):
    docs = {}          # id -> date string (YYYY-MM-DD)
    lokale = {}        # id -> dict(area, izby, floor, price, lon, lat)  [residential only]
    budynki = {}       # id -> dict(rodzaj, area)
    dzialki = {}       # id -> (easting, northing) centroid in EPSG:2178
    nieruch = {}       # id -> dict(rodzaj, lokal[], budynek[], dzialka[], cena)
    transakcje = []    # list of dict(price, market, tx_kind, doc, nier)

    n = 0
    ctx = etree.iterparse(path, events=("end",), tag=GML + "featureMember")
    for _, fm in ctx:
        obj = fm[0] if len(fm) else None
        if obj is not None:
            ln = etree.QName(obj).localname
            gid = obj.get(GML + "id")

            if ln == "RCN_Dokument":
                d = txt(obj, "dataSporzadzeniaDokumentu")
                if d:
                    docs[gid] = d

            elif ln == "RCN_Lokal":
                if txt(obj, "funkcjaLokalu") == FUNKCJA_MIESZKALNA:  # keep residential only
                    coords = None
                    pl = first_poslist(obj.find(RCN + "georeferencja"))
                    if pl:
                        coords = point_2178_to_wgs(*pl[0])
                    lokale[gid] = {
                        "area": to_float(txt(obj, "powUzytkowaLokalu")),
                        "izby": to_int(txt(obj, "liczbaIzb")),
                        "floor": to_int(txt(obj, "nrKondygnacji")),
                        "price": to_float(txt(obj, "cenaLokaluBrutto")),
                        "coords": coords,
                    }

            elif ln == "RCN_Budynek":
                budynki[gid] = {
                    "rodzaj": txt(obj, "rodzajBudynku"),
                    "area": to_float(txt(obj, "powierzchniaUzytkowaBudynku")),
                }

            elif ln == "RCN_Dzialka":
                pl = first_poslist(obj.find(RCN + "geometria"))
                if pl and len(pl) >= 3:
                    c = Polygon(pl).centroid
                    dzialki[gid] = (c.x, c.y)

            elif ln == "RCN_Nieruchomosc":
                nieruch[gid] = {
                    "rodzaj": txt(obj, "rodzajNieruchomosci"),
                    "lokal": hrefs(obj, "lokal"),
                    "budynek": hrefs(obj, "budynek"),
                    "dzialka": hrefs(obj, "dzialka"),
                    "cena": to_float(txt(obj, "cenaNieruchomosciBrutto")),
                }

            elif ln == "RCN_Transakcja":
                transakcje.append({
                    "price": to_float(txt(obj, "cenaTransakcjiBrutto")),
                    "market": txt(obj, "rodzajRynku"),
                    "tx_kind": txt(obj, "rodzajTransakcji"),
                    "doc": href(obj, "podstawaPrawna"),
                    "nier": href(obj, "nieruchomosc"),
                })

        fm.clear()
        n += 1
        if n % 200000 == 0:
            print(f"  ...{n:,} featureMembers parsed", file=sys.stderr)

    print(f"  parsed: {len(transakcje):,} tx, {len(nieruch):,} nieruchomosci, "
          f"{len(lokale):,} residential lokale, {len(budynki):,} budynki, "
          f"{len(dzialki):,} dzialki, {len(docs):,} docs", file=sys.stderr)
    return docs, lokale, budynki, dzialki, nieruch, transakcje


# ---------------------------------------------------------------------------
# Districts: load 18 dzielnice, expose a point-in-polygon tagger
# ---------------------------------------------------------------------------
def load_districts(path: Path):
    gj = json.loads(path.read_text())
    feats = []
    for f in gj["features"]:
        name = f["properties"].get("name")
        if name and name.lower() != "warszawa":   # drop the whole-city outline
            feats.append((name, shape(f["geometry"])))
    out_geojson = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"name": n}, "geometry": mapping(g)}
            for n, g in feats
        ],
    }
    return feats, out_geojson


def tag_district(feats, lon, lat):
    p = Point(lon, lat)
    for name, geom in feats:
        if geom.contains(p):
            return name
    return None


# ---------------------------------------------------------------------------
# Pass 2: resolve transactions into slim rows
# ---------------------------------------------------------------------------
def build_rows(lookups, districts, limit=None):
    docs, lokale, budynki, dzialki, nieruch, transakcje = lookups
    today = date.today().isoformat()
    rows = []
    stats = Counter()

    for t in transakcje:
        stats["total"] += 1

        # transaction-type filter (drop explicit non-market deals)
        if t["tx_kind"] in TX_KIND_DROP:
            stats["drop_tx_kind"] += 1
            continue

        # date filter
        d = docs.get(t["doc"])
        if not d or not (CUTOFF <= d <= today):
            stats["drop_date"] += 1
            continue

        nr = nieruch.get(t["nier"])
        if nr is None:
            stats["drop_no_nieruchomosc"] += 1
            continue

        market = to_int(t["market"])

        if nr["rodzaj"] == RODZAJ_LOKALOWA:
            # ---- flat: one row per residential lokal in the property ----
            made = False
            for lid in nr["lokal"]:
                lok = lokale.get(lid)        # residential-only dict (others filtered out in pass 1)
                if lok is None:
                    continue
                coords = lok["coords"]
                if coords is None:           # fall back to plot centroid
                    coords = _dzialka_coords(nr, dzialki)
                if coords is None:
                    stats["drop_no_geom"] += 1
                    continue
                price = lok["price"] or nr["cena"] or t["price"]
                area = lok["area"]
                if not price or price <= 0:
                    stats["drop_no_price"] += 1
                    continue
                if not area or area < MIN_FLAT_AREA:
                    stats["drop_sanity_area"] += 1
                    continue
                if not (FLAT_PPM2_MIN <= price / area <= FLAT_PPM2_MAX):
                    stats["drop_sanity_ppm2"] += 1
                    continue
                rows.append(_row("flat", coords, price, area, lok["izby"], lok["floor"],
                                 d, market, districts))
                stats["flat"] += 1
                made = True
            if not made:
                stats["drop_flat_unresolved"] += 1

        elif nr["rodzaj"] == RODZAJ_GRUNT_ZABUDOWANA:
            # ---- house: developed plot with a residential building ----
            res_bldg = next((budynki[b] for b in nr["budynek"]
                             if b in budynki and budynki[b]["rodzaj"] == BUDYNEK_MIESZKALNY), None)
            if res_bldg is None:
                stats["drop_house_not_residential"] += 1
                continue
            coords = _dzialka_coords(nr, dzialki)
            if coords is None:
                stats["drop_no_geom"] += 1
                continue
            price = nr["cena"] or t["price"]
            if not price or price < MIN_HOUSE_PRICE:
                stats["drop_sanity_price"] += 1
                continue
            rows.append(_row("house", coords, price, res_bldg["area"], None, None,
                             d, market, districts))
            stats["house"] += 1
        else:
            stats["drop_other_kind"] += 1

        if limit and len(rows) >= limit:
            break

    return rows, stats


def _dzialka_coords(nr, dzialki):
    for did in nr["dzialka"]:
        if did in dzialki:
            e, n = dzialki[did]
            return point_2178_to_wgs(e, n)
    return None


def _row(kind, coords, price, area, izby, floor, d, market, districts):
    lon, lat = coords
    ppm2 = round(price / area) if area and area > 0 else None
    return [
        lon, lat,
        round(price),
        round(area, 1) if area else None,
        ppm2,
        izby,
        floor,
        d,
        market,
        kind,
        tag_district(districts, lon, lat),
    ]


FIELDS = ["lon", "lat", "price", "area", "ppm2", "izby", "floor", "date", "market", "kind", "district"]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N output rows (quick validation)")
    args = ap.parse_args()

    if not RAW_GML.exists():
        sys.exit(f"missing raw GML: {RAW_GML}")
    if not DISTRICTS_SRC.exists():
        sys.exit(f"missing districts source: {DISTRICTS_SRC}")

    print("loading districts...", file=sys.stderr)
    districts, districts_geojson = load_districts(DISTRICTS_SRC)
    print(f"  {len(districts)} districts", file=sys.stderr)

    print("pass 1: streaming GML and building lookups (this takes a few minutes)...", file=sys.stderr)
    lookups = build_lookups(RAW_GML)

    print("pass 2: resolving transactions...", file=sys.stderr)
    rows, stats = build_rows(lookups, districts, limit=args.limit)

    # sanity: coordinates should land inside Warsaw's rough bbox
    bad = [r for r in rows[:5000] if not (20.7 <= r[0] <= 21.4 and 52.0 <= r[1] <= 52.5)]
    print(f"\n=== STATS ===\n{json.dumps(stats, indent=2)}", file=sys.stderr)
    print(f"rows: {len(rows):,} | out-of-bbox in first 5k: {len(bad)}", file=sys.stderr)
    if rows:
        no_district = sum(1 for r in rows if r[10] is None)
        print(f"sample row: {rows[0]}", file=sys.stderr)
        print(f"rows with no district: {no_district:,}", file=sys.stderr)

    OUT_TX.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated": RAW_GML.stem,
        "cutoff": CUTOFF,
        "fields": FIELDS,
        "rows": rows,
    }
    OUT_TX.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    OUT_DISTRICTS.write_text(json.dumps(districts_geojson, ensure_ascii=False))
    print(f"\nwrote {OUT_TX} ({OUT_TX.stat().st_size/1e6:.1f} MB)", file=sys.stderr)
    print(f"wrote {OUT_DISTRICTS} ({OUT_DISTRICTS.stat().st_size/1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
