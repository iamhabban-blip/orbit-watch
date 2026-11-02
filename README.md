# Orbit Watch

**Military air activity from public ADS-B, with pattern detection.**

**Live:** https://iamhabban-blip.github.io/orbit-watch/

Most flight trackers show dots. Orbit Watch reads the tracks and tells you what the aircraft are doing: a tanker flying a racetrack, fighters closing on it at the same altitude, a surveillance aircraft holding a station for three hours, an emergency squawk.

## What it detects

| Signal | How |
|---|---|
| **Orbits and racetracks** | Sustained same-direction turning (330°+) inside a small area over the last 90 minutes. Reports loiter time, laps and track size. Low, tight loops are labelled as training circuits instead. |
| **Possible air-to-air refuelling** | A tanker with fighters, bombers or transports within 30 km and 4,000 ft. |
| **Emergencies** | Squawk 7700 / 7600 / 7500, the emergency field, and 7400 (drone lost link). |
| **High-interest types** | Tankers, ISR / AEW, bombers, drones and VIP flights airborne. |
| **Role** | Inferred from ICAO type codes and known callsign patterns (e.g. SAM, FORTE, JAKE, QID). |

Everything is ranked by interest, so the most notable activity sits at the top of the **Flagged** list.

## Features

- Live map with heading-rotated aircraft icons, colour-coded by role, and 6-hour trails
- Flagged / all-aircraft lists with search (callsign, type, registration, hex)
- Role filters with counts, region presets, "only what's on the map", ground and lost-contact toggles
- Aircraft detail panel: plain-English explanation of every flag, altitude profile, position, squawk, links to ADSB.lol and ADS-B Exchange
- Shareable links to a single aircraft (`#hex`) and CSV export of the current view
- Data freshness indicator; works on desktop and mobile

## How it works

There is no server. A scheduled **GitHub Actions** job (`.github/workflows/collect.yml`) runs every 5–15 minutes:

1. `scripts/collect.py` takes 8 snapshots, 30 seconds apart, from the community feeds' military endpoints (adsb.lol, falling back to adsb.fi and airplanes.live).
2. It merges them into a rolling 6-hour history, thins straight-line segments to keep the file small, and drops surface vehicles and towers.
3. The site and `data/history.json` are deployed to GitHub Pages. The page reloads the data every minute and runs all the analysis in the browser.

Python standard library only; front end is vanilla JavaScript with Leaflet.

```bash
python scripts/collect.py --out site --samples 2 --interval 10   # build locally
python -m http.server -d site 8000                               # then open http://localhost:8000
```

## Limits and responsible use

- Only data that aircraft broadcast publicly and that volunteers' receivers pick up. Many military aircraft never broadcast, and coverage is thin in parts of Asia and Africa. **Absence of data means nothing.**
- Positions are 5–15 minutes old by design. It's a pattern and history tool, not a live targeting feed.
- Roles and flags are heuristics. Treat them as leads to verify, not facts.
- GitHub pauses scheduled workflows after 60 days without repository activity; re-enable it from the Actions tab.

Built by **Habban** (BS Aviation Management) · [LinkedIn](https://www.linkedin.com/in/muhammad-habban1/) · [Aviation YouTube](https://youtube.com/@avfreak-s2c) · also see [Turnaround Lab](https://iamhabban-blip.github.io/turnaround-lab/)
