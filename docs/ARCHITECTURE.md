# Architecture

## Stack

| Layer | Choice | What it does |
|---|---|---|
| Language | TypeScript | Types are documentation that can't go stale |
| Framework | Next.js (App Router) | Routing, dev server, production build |
| UI | React | Components that re-render when data changes |
| Styling | Tailwind CSS | Utility classes; no separate stylesheet to maintain |
| Components | shadcn/ui | Copies source **into** the repo — you own and can edit it |
| Map rendering | Hand-rolled SVG | See below |
| Pathfinding | Hand-rolled A* | ~60 lines. Writing it teaches the algorithm |
| Sensors | `DeviceMotionEvent` | Accelerometer + gyroscope, ~60 Hz |
| QR | `BarcodeDetector` → `jsQR` | Native where available; iOS has neither, so jsQR |
| Data | JSON files in the repo | No database to run or pay for |
| Hosting | Vercel | Free, and HTTPS is mandatory for sensors |
| Tests | Vitest | On routing and step detection only |

## Two decisions worth defending

**SVG instead of deck.gl or MapLibre.** Mapping libraries are built for the whole
Earth: tile pyramids, projections, zoom levels. We have one floor of one building,
already in metres. Rendering it is a coordinate transform and some `<path>`
elements. A library would hide the interesting part behind an abstraction, and the
3D view that would have justified deck.gl is cut.

**JSON files instead of a database.** The entire map is a few hundred KB. Put it in
the repo and you get version history, diffs, and code review of map changes for
free, with no server, no schema migration, and no query latency. Revisit when a
second person needs to edit maps concurrently — not before.

## What we deliberately don't use

No database, no authentication, no state-management library, no mapping library,
no commercial positioning SDK, no AR framework.

That last one matters: iOS Safari exposes no magnetometer, no Bluetooth, and no
WebXR, which rules out Oriient, IndoorAtlas, and Situm for a web app. See
[POSITIONING.md](POSITIONING.md).

## Coordinates

Three frames, converted at defined boundaries:

```
WGS84 lat/lon + floor      stored on disk       survives forever, feeds AR
        |  project once at load, origin = building centroid
        v
local metres (x, y)        all math             routing, positioning, distances
        |  scale + translate at render time
        v
SVG pixels                 drawing only
```

Everything on disk is real-world coordinates. Everything computed is metres.
Pixels exist only inside render functions. Getting this wrong — tracing into
arbitrary pixel space — would make AR a rewrite instead of an addition.

At building scale, a flat-earth approximation is accurate to millimetres:

```ts
x = (lon - lon0) * 111320 * cos(lat0)
y = (lat - lat0) * 110540
```

## Layout

```
app/                      Next.js routes
  page.tsx                search + map
  tracer/page.tsx         dev-only map editor
lib/
  core/                   pure logic, NO React and NO browser APIs
    graph.ts              nodes, edges, A*
    positioning.ts        step detection, turn tracking, graph snapping
    geo.ts                lat/lon <-> metres
    directions.ts         edge bearings -> "turn left"
  render/                 SVG drawing
components/               React UI
data/
  wheatley/
    nodes.json  edges.json  rooms.json  anchors.json
probes/                   Phase 0 sensor tests (throwaway, kept for reference)
docs/
```

**`lib/core/` imports nothing.** No React, no `window`, no `document`. That's what
lets the same code run in the browser, in Node tests, and in the analysis scripts.
It's the one architectural rule worth protecting.
