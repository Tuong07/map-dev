# map-dev — Indoor Navigation for UMass Boston

Google Maps, but for the inside of buildings. Search a room number, get a route
through the building with turn-by-turn directions. Built for Wheatley Hall, a
building most students describe as a maze.

## Tech Stack

- **Framework:** Next.js (App Router), TypeScript
- **Styling:** Tailwind CSS
- **Rendering:** Hand-rolled SVG — no mapping library
- **Pathfinding:** Hand-written A\* over a corridor graph — no routing library
- **Data:** JSON in the repo — [no backend, no database](docs/ARCHITECTURE.md)
- **OCR:** Apple Vision framework via Swift — no dependency, no API cost
- **Testing:** Vitest — 22 tests on pathfinding and geometry
- **Deployment:** Vercel

## Implemented Features

- **Room Search** — type a room number, fuzzy-matched (`1-053`, `1 053`, `1053` all work)
- **Floor Map** — the real architectural floor plan, rooms highlighted, pan and zoom
- **Routing** — A\* across **6,320 room pairs at 100% coverage**, 0.011 ms per route
- **Turn-by-Turn Directions** — generated from corridor geometry, not hand-written
- **Multi-Floor Routing** — stairs and lifts, with a step-free routing toggle
- **Map Authoring Tool** (`/tracer`) — draw corridors on a floor plan, doors auto-link
  to the nearest room, disconnected-network detection. Works on any building
- **OCR Data Pipeline** — **210 rooms** extracted from architectural PDFs with zero typing
- **Sensor Test Harness** (`probes/`) — record-and-replay analyzer for tuning phone
  positioning offline

## In Progress

- **Live Position Tracking** — components validated on hardware, end-to-end test pending
- **Level 2 Corridors** — rooms extracted, corridors not yet traced
- **AR Wayfinding** — [designed](docs/AR.md), not built

---

## What's actually here

This repo contains three things, and the two you can't see in the app are the
interesting ones.

| | What it is |
|---|---|
| **The app** | Room search, floor map, A\* routing, turn-by-turn directions |
| **The tester** (`probes/`) | Sensor test harness — proves phone positioning is possible *before* building on that assumption |
| **The tracer** (`/tracer`) | Map authoring tool — turns architectural PDFs into a routable corridor graph |

Measured results from all three: **[docs/OBSERVATIONS.md](docs/OBSERVATIONS.md)**

---

## Quick start

```bash
git clone git@github.com:Tuong07/map-dev.git
cd map-dev
npm install
npm run dev
```

| URL | What |
|---|---|
| `http://localhost:3000` | The app |
| `http://localhost:3000/tracer` | Map editor — Wheatley Level 1 |
| `http://localhost:3000/tracer?floor=2` | Map editor — Level 2 |

`Ctrl+C` stops it.

**Note:** `npm run dev` serves plain HTTP. Use `npm run dev:https` only for phone
sensor testing — browsers refuse to release motion data over an insecure origin.

---

## Walkthrough — the tester

**What it's for.** GPS doesn't work indoors. Before building a map, a router and
a UI on the assumption that a phone can track you, this harness finds out whether
it actually can. Nothing here ships; the only output that survives is a handful
of tuned constants.

### Running it

Sensors require HTTPS, and your phone can't reach `localhost`. Two options:

```bash
npm run dev:https          # then open https://<your-mac-ip>:3000/probes/
```

or deploy and open it on your phone:

```bash
npx vercel --prod
```

Then open `/probes/` on the phone and work through the pages in order.

### The tests

| | Page | Question it answers | Where |
|---|---|---|---|
| 1 | `sensors.html` | Can the phone read motion at all, fast enough? | Desk |
| R | `record.html` | *(records a walk for offline analysis)* | Hallway |
| 2 | `steps.html` | Does it count steps within 5%? | Hallway |
| 3 | `turns.html` | Does it know left from right? | Hallway |
| 4 | `qr.html` | Do QR codes scan fast in dim light? | The building |
| 5 | `graph.html` | Does the position dot follow you? **Go / no-go** | The building |

**Run Test 1 first.** If the phone can't report motion at 30 Hz or better,
nothing downstream matters and the plan changes rather than the deadline slipping.

### Record and replay — the part that mattered

Tuning step and turn detection by walking a hallway, tweaking a number, and
walking again does not converge. I lost four rounds of plausible-looking fixes
that way.

`record.html` logs every raw sensor reading to a JSON file while you walk once.
`analyze.mjs` replays that file through the *same detection code the app uses*,
instantly, on a laptop:

```bash
node probes/analyze.mjs walk-01.json
node probes/analyze.mjs walk-01.json --sweep --truth 100
```

One recorded walk replaces fifty trips down a corridor — and it found the real
bug on the first pass. The phone's gyroscope reports rotation on a different
axis than the W3C spec documents, so 360° of real turning was integrating to 25°.
Full write-up in [OBSERVATIONS §3](docs/OBSERVATIONS.md#3-turn-detection).

**Lesson worth keeping:** when two rounds of plausible fixes don't move the
needle, stop fixing and start measuring.

---

## Walkthrough — the tracer

**What it's for.** Architectural floor plans are pictures of walls. They contain
no machine-readable information about where you can *walk* — a hallway is the
empty space between rooms, never drawn as an object. The tracer is where that
gets supplied.

It's **desktop-only and development-only.** It writes files to disk, which Vercel
cannot do, and it returns 404 outside `NODE_ENV=development`. Students never see
it; it's a level editor, not part of the game.

### Step 1 — extract rooms from the PDF

```bash
npx tsx scripts/extract-rooms.ts --page 1 --floor 1
npx tsx scripts/extract-rooms.ts --page 2 --floor 2
```

This renders the PDF page, runs OCR (Apple Vision, via a small Swift tool — no
install, no API key, no per-page cost), and writes room numbers, positions and
types to `data/wheatley/level-N/rooms.raw.json`. It also recovers real-world
scale by least-squares fitting the drawing's own scale bar.

**210 rooms across two floors, extracted with zero typing.**

Requires `poppler` for PDF rendering:

```bash
brew install poppler
```

### Step 2 — draw the corridors

```bash
npm run dev
```

Open `http://localhost:3000/tracer`.

Red dots are rooms OCR found. Green means connected. **Your job is turning red
dots green.**

| Mode | Key | What it does |
|---|---|---|
| Corridor | `C` | Click along the middle of a hallway. Points chain into a line |
| Door | `D` | Click a doorway. It names itself from the nearest room |
| Stair | `S` | Place a stairwell. Same label on two floors links them |
| Lift | `E` | Place a lift |
| Entrance | `N` | Place a building entrance |
| Select | `V` | Drag nodes, delete with `Backspace`, double-click a door to retype it |
| Pan | `H` | Or hold `Space` and drag, in any mode |

**Draw the hallway itself** — a line down the middle of the empty corridor.
You're drawing the *road*, not the driveways. Never click inside a room.

`Esc` ends a run so the next click starts a fresh hallway. Clicking an existing
point joins to it; clicking on an existing corridor *line* splits it and joins
there. `⌘Z` undoes. Scroll zooms, `Fit` resets the view.

### Step 3 — link the doors

Click **Auto-link doors**. Every door connects to its nearest corridor, splitting
that corridor to place the junction exactly. Safe to re-run — it rebuilds from
scratch rather than duplicating.

### Step 4 — fix what it flags

The side panel lists every problem it can detect:

- rooms with no door placed
- nodes connected to nothing
- **corridors that form disconnected islands**
- low-confidence OCR reads

That third one is the important one. Hand-traced corridors that *look* like they
cross often don't share a node — the map appears finished while routing quietly
fails. Level 1 was drawn as 13 separate islands with only **18% of room pairs
routable**. `find` zooms to a problem; `link` re-points a door.

If the network is badly fragmented, this fixes it geometrically:

```bash
npx tsx scripts/join-islands.ts --floor 1 --dry   # preview
npx tsx scripts/join-islands.ts --floor 1         # apply
```

It repeatedly joins the closest approach between disconnected pieces, with a
distance cap so it never invents a path through a wall. On Level 1: 12 joins,
all under 5 m, **13 islands → 1, 18% → 100% routable.**

### Step 5 — save and verify

Click **Save**. It writes `nodes.json`, `edges.json` and `rooms.json` — the files
the app actually routes on.

```bash
npm run validate     # orphan nodes, unreachable rooms, absurd edge lengths
npm test             # pathfinding + geometry
```

### Using it on a different building

Nothing in the tracer knows the word "Wheatley." Point `extract-rooms.ts` at
another PDF and pass `--building`:

```bash
npx tsx scripts/extract-rooms.ts --pdf healey.pdf --page 1 --floor 1 --building healey
```

Then open `/tracer?building=healey&floor=1`.

---

## Commands

| Command | What |
|---|---|
| `npm run dev` | Development server (HTTP) |
| `npm run dev:https` | Development server over HTTPS — needed for phone sensors |
| `npm run build` | Production build; catches type errors dev mode allows |
| `npm test` | Vitest — pathfinding and geometry |
| `npm run validate` | Map data integrity checks |
| `npx tsx scripts/extract-rooms.ts --page N --floor N` | OCR a floor plan page |
| `npx tsx scripts/join-islands.ts --floor N` | Stitch a fragmented corridor network |

---

## Structure

```
app/
  page.tsx              the app — search, map, routing
  tracer/               the map editor (dev-only)
  api/tracer/           load/save endpoints (dev-only, 404 in production)
lib/
  core/                 pure logic — imports nothing, no React, no DOM
    graph.ts            corridor graph + hand-written A*
    geo.ts              lat/lon <-> metres <-> pixels
    autolink.ts         door-to-corridor projection
    directions.ts       edge bearings -> "turn left"
  render/               SVG drawing
probes/                 Phase 0 sensor tests (throwaway, kept for reference)
scripts/                OCR extraction, island stitching, validation
data/wheatley/          the map itself
docs/                   design decisions and measured results
```

**One architectural rule worth knowing:** `lib/core/` imports nothing. No React,
no `window`, no `document`. That's what lets identical code run in the browser,
in Node tests, and in the offline sensor analyzer — which is how a recorded walk
can be replayed through the exact detectors the phone uses.

**Coordinates:** lat/lon on disk, metres in logic, pixels only when drawing.
Tracing into pixel space would make an AR feature a rewrite instead of an
addition.

---

## Documentation

| | |
|---|---|
| [PRD.md](docs/PRD.md) | Scope, non-goals, definition of done |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack choices and the reasoning behind them |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | Node/edge/room/anchor schemas |
| [POSITIONING.md](docs/POSITIONING.md) | How indoor positioning works, and its limits |
| [OBSERVATIONS.md](docs/OBSERVATIONS.md) | **Every measured result in the project** |
| [AR.md](docs/AR.md) | AR design, and why it needs no library |
| [ROADMAP.md](docs/ROADMAP.md) | What's done, what's next |
