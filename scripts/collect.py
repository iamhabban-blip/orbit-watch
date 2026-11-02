#!/usr/bin/env python3
"""Orbit Watch data collector.

Pulls publicly broadcast military ADS-B positions from community feeds,
merges them into a rolling history (default 6 hours) and builds the static
site folder that GitHub Pages serves. Standard library only.

Run locally:  python scripts/collect.py --out site --samples 2 --interval 10
"""
import argparse
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.request

SOURCES = [
    ("adsb.lol", "https://api.adsb.lol/v2/mil"),
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/mil"),
    ("airplanes.live", "https://api.airplanes.live/v2/mil"),
]
UA = "orbit-watch/1.0 (+https://github.com/iamhabban-blip/orbit-watch)"
WEB_FILES = ["index.html", "style.css", "app.js", "favicon.svg"]
EMPTY_CALLSIGN = set("@ ")


def fetch_json(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def snapshot():
    """Return (source_name, unix_seconds, aircraft_list) from the first feed that answers."""
    for name, url in SOURCES:
        try:
            j = fetch_json(url)
            ac = j.get("ac") or j.get("aircraft") or []
            now = j.get("now") or time.time()
            if now > 1e11:  # milliseconds
                now = now / 1000
            return name, float(now), ac
        except Exception as e:  # noqa: BLE001 - any feed failure falls through to the next
            print(f"[collect] {name} failed: {e}", file=sys.stderr)
    return None, time.time(), []


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(a)))


def is_aircraft(a):
    cat = a.get("category") or ""
    if cat.startswith("C") or a.get("t") == "TWR":  # surface vehicles, obstacles, towers
        return False
    return a.get("lat") is not None and a.get("lon") is not None


def callsign(a):
    s = (a.get("flight") or "").strip()
    return "" if not s or set(s) <= EMPTY_CALLSIGN else s


def altitude(a):
    v = a.get("alt_baro")
    if v == "ground":
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    g = a.get("alt_geom")
    return int(g) if isinstance(g, (int, float)) else None


def num(v, nd=0):
    if not isinstance(v, (int, float)):
        return None
    return round(v, nd) if nd else int(round(v))


def add_point(rec, p):
    """Append a trail point, thinning straight-and-level segments to keep the file small."""
    pts = rec["pts"]
    if pts:
        last = pts[-1]
        if p[0] - last[0] < 15:
            return
        moved = haversine_km(last[1], last[2], p[1], p[2])
        turned = 0
        if p[4] is not None and last[4] is not None:
            turned = abs((p[4] - last[4] + 180) % 360 - 180)
        if len(pts) >= 2 and moved < 1.5 and turned < 8 and p[0] - pts[-2][0] < 180:
            pts[-1] = p  # slide the end of a straight segment forward
            return
    pts.append(p)


def merge(history, ac_list, now):
    aircraft = history.setdefault("aircraft", {})
    for a in ac_list:
        if not is_aircraft(a):
            continue
        hexid = (a.get("hex") or "").lower().lstrip("~")
        if not re.fullmatch(r"[0-9a-f]{6}", hexid):
            continue
        seen = a.get("seen_pos", a.get("seen", 0)) or 0
        ts = int(now - float(seen))
        rec = aircraft.setdefault(hexid, {"pts": []})
        cs = callsign(a)
        if cs:
            rec["c"] = cs
        for key, src in (("t", "t"), ("r", "r"), ("cat", "category"), ("desc", "desc")):
            if a.get(src):
                rec[key] = a[src]
        rec["sq"] = a.get("squawk") or rec.get("sq")
        rec["em"] = a.get("emergency") if a.get("emergency") not in (None, "none") else None
        rec["gnd"] = a.get("alt_baro") == "ground"
        rec["last"] = max(ts, rec.get("last", 0))
        add_point(rec, [ts, num(a["lat"], 4), num(a["lon"], 4), altitude(a), num(a.get("track")), num(a.get("gs"))])


def trim(history, now, hours):
    cutoff = now - hours * 3600
    aircraft = history.get("aircraft", {})
    for hexid in list(aircraft):
        rec = aircraft[hexid]
        rec["pts"] = [p for p in rec["pts"] if p[0] >= cutoff]
        if not rec["pts"]:
            del aircraft[hexid]


def load_previous(local_path):
    url = os.environ.get("PREV_URL")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not url and repo and "/" in repo:
        owner, name = repo.split("/", 1)
        url = f"https://{owner.lower()}.github.io/{name}/data/history.json"
    if url:
        try:
            h = fetch_json(f"{url}?t={int(time.time())}")
            print(f"[collect] loaded previous history: {len(h.get('aircraft', {}))} aircraft")
            return h
        except Exception as e:  # noqa: BLE001
            print(f"[collect] no previous history at {url}: {e}", file=sys.stderr)
    if os.path.exists(local_path):
        with open(local_path, encoding="utf-8") as f:
            return json.load(f)
    return {"v": 1, "aircraft": {}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site")
    ap.add_argument("--samples", type=int, default=int(os.environ.get("SAMPLES", 8)))
    ap.add_argument("--interval", type=int, default=int(os.environ.get("INTERVAL", 30)))
    ap.add_argument("--hours", type=float, default=float(os.environ.get("HISTORY_HOURS", 6)))
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.abspath(args.out)
    os.makedirs(os.path.join(out, "data"), exist_ok=True)
    history = load_previous(os.path.join(out, "data", "history.json"))
    history["v"] = 1

    source, now, ok = None, time.time(), 0
    for i in range(args.samples):
        name, now, ac = snapshot()
        if name:
            source, ok = name, ok + 1
            merge(history, ac, now)
            print(f"[collect] sample {i + 1}/{args.samples} from {name}: {len(ac)} aircraft")
        if i < args.samples - 1:
            time.sleep(args.interval)

    trim(history, now, args.hours)
    if ok:
        history["generatedAt"] = int(now)
        history["source"] = source
    history["windowHours"] = args.hours

    for f in WEB_FILES:
        src = os.path.join(root, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(out, f))
    # Cache-bust the page's own assets so browsers pick up code changes on the next load.
    page = os.path.join(out, "index.html")
    if os.path.exists(page):
        v = int(time.time())
        with open(page, encoding="utf-8") as fh:
            html = fh.read()
        html = html.replace('href="style.css"', f'href="style.css?v={v}"').replace('src="app.js"', f'src="app.js?v={v}"')
        with open(page, "w", encoding="utf-8") as fh:
            fh.write(html)
    with open(os.path.join(out, "data", "history.json"), "w", encoding="utf-8") as fh:
        json.dump(history, fh, separators=(",", ":"))
    n = len(history.get("aircraft", {}))
    print(f"[collect] wrote {n} aircraft, {ok}/{args.samples} samples ok, source={source}")
    if not ok and not n:
        sys.exit(1)


if __name__ == "__main__":
    main()
