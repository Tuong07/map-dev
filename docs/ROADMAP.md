# Roadmap

Deadline: **before September 2026**. Capacity 2–3 hrs/day, ~60 working hours.

Every stage ends with something demoable. The risky feature is last, so failing it
costs a feature, not the project.

## Phase 0 — sensor validation · mostly done

Throwaway pages in `probes/`. Nothing here ships; only the tuned numbers do.

| Test | Status | Result |
|---|---|---|
| 1 · Raw sensors | **pass** | 60 Hz, gravity 9.8, gyro quiet |
| 2 · Step counter | **pass** | ±5% worst case, net zero over 4 walks |
| 3 · Turn detector | **pass** | 4/4 turns, −345° on a square |
| 4 · QR scan | deferred | only decides sticker size; needed by week 4 |
| 5 · Fake corridor | **outstanding** | the go/no-go for the blue dot |

## Week 1 — the tracer

Build the map editor: load a floor plan, click four points to georeference it
against the OpenStreetMap building footprint, then click to place corridor nodes,
drag edges, and tag doors with room numbers.

Highest-leverage thing in the project — nothing can be tested against real data
until a map exists, and it can't be parallelised.

**Blocked on:** the Wheatley floor plan PDF (behind UMB student login).
**Not blocked on Test 5.**

## Week 2 — the map

Survey and trace one floor. An afternoon of walking, a couple of hours clicking.

Output: `nodes.json`, `edges.json`, `rooms.json`, `anchors.json`, plus the
validation script from [DATA_MODEL.md](DATA_MODEL.md).

**This week decides the deadline.** Clean vector PDF → fast. A scan, or no usable
plan → slower, and we cut to a partial floor.

## Week 3 — the app becomes useful

1. Next.js shell
2. Room-number search
3. SVG floor map with the room highlighted
4. A* routing + written turn-by-turn

**End of this week you have a working, demoable app.** No sensors involved, so
nothing here depends on Phase 0. If everything after collapses, this still ships.

## Week 4 — the blue dot

Only if Test 5 passes.

- QR scanner setting position, floor, and heading
- The Phase 0 positioning loop wired to the real graph
- Blue dot with the growing drift circle
- Stride calibration screen
- Test 4, then print and tape ~15 anchors
- Field test and fix

Then the README — for a resume project it matters nearly as much as the code.
Screenshots, architecture, and specifically *why* this uses a hand-rolled
positioning system instead of an SDK. That's the most interesting thing here and
it should be written down.

## Phase 2 — after the deadline

AR floating arrow ([AR.md](AR.md)) · second floor · elevators and step-free
routing · shareable room links · offline PWA · marker-based AR · LiDAR occlusion

## Cut order

Already cut: 3D exploded view, second floor, elevators, sharing, offline, dark mode.

If it slips further: **blue dot** (leaves week 3's app), then **turn-by-turn**
(leaves a searchable map). Each cut still leaves something real.

## What's blocking right now

1. **Wheatley floor plan PDF** — blocks weeks 1–2
2. **Test 5** — decides whether week 4 happens at all
