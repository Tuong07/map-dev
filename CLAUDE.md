# map-dev

Indoor wayfinding for UMass Boston Wheatley Hall. Read [docs/PRD.md](docs/PRD.md)
first, then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The goal shapes the code

This is a resume piece and a learning project. Tuong needs to be able to reread
this code in six months, explain it in an interview, and rebuild it from scratch.

That outranks cleverness and it outranks brevity:

- **Explain what code does and why**, not just what changed.
- **Prefer explicit over clever.** A slightly longer function that reads plainly
  beats a dense one-liner.
- **Prefer fewer dependencies.** A library he can't explain is a liability;
  hand-rolled code he understands is an asset. This is why routing is a
  hand-written A* and the map is hand-drawn SVG.
- **Comment the non-obvious.** Not what the line does — why it has to be that way.
  The gyro axis resolver in `probes/core.mjs` is the model to follow.
- **End every response with a short summary**: what it is, what changed, what it
  means.

## Rules that matter

**`lib/core/` imports nothing.** No React, no `window`, no `document`. That's what
lets the same code run in the browser, in Node tests, and in analysis scripts. If
something in `core/` needs the DOM, it belongs somewhere else.

**Coordinates: lat/lon on disk, metres in logic, pixels only when drawing.**
Tracing into pixel space would make AR a rewrite. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Derived data is computed, never authored.** Edge lengths come from coordinates.
Hand-entered values drift out of sync and produce bugs that are invisible on a map.

**Record anchor bearing and height** even though nothing uses them yet. AR needs
them and re-surveying is expensive.

## Testing

Vitest, on pathfinding and positioning only — that's where real bugs live. Skip UI
tests.

**When two rounds of plausible fixes don't move the needle, stop fixing and start
measuring.** Phase 0 lost four rounds to reasoning from screenshots; one recorded
data file found the bug in a single pass. `probes/analyze.mjs` replays recordings
through the same detectors the browser uses.

## Sensor gotchas

Learned the hard way, all documented in [docs/POSITIONING.md](docs/POSITIONING.md):

- Sensors need **HTTPS even on localhost** — use `next dev --experimental-https`
- iOS needs `DeviceMotionEvent.requestPermission()` **from a real user gesture**
- **Gyro axes don't follow the W3C spec.** Resolve the mapping at runtime
- Gyro bias is **per axis**, not a single number
- The accelerometer reports gravity **plus motion** — low-pass before using it as
  a reference
- Step thresholds must **scale to walking effort**; fixed values return nothing
  when someone strolls while watching the screen
- iOS caches aggressively — append `?v=N` when testing on a phone

## Commands

```bash
npm run dev        # HTTPS dev server
npm run validate   # map data integrity
npm test           # vitest
npx vercel --prod --yes
```
