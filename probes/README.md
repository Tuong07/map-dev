# Phase 0 — sensor validation

Throwaway test pages that answer one question each. **None of this code ships.** The
only output that survives is `tuned.json` — five or six numbers that get copied into
the real app.

The point is to find out whether a live blue dot is possible on a phone browser
*before* building a map, a router, and a UI on top of that assumption.

## Why these exist

Indoor GPS doesn't work. Safari won't expose the magnetometer, Bluetooth, or WebXR AR,
so every commercial indoor-positioning SDK is off the table for a web app. What's left
is the accelerometer, the gyroscope, and a camera — plus one structural advantage:
**a person in a hallway can't walk through walls.** Constrain position to a corridor
graph and the problem stops being "estimate a point in 2D space" and becomes "how far
along this segment are they, and which way did they turn."

These pages test whether that actually works on real hardware.

## Order

| | Page | Question | Where |
|---|---|---|---|
| 1 | `sensors.html` | Can the phone read motion at all, fast enough? | Desk |
| R | `record.html` | — | Hallway |
| 2 | `steps.html` | Does it count steps within 5%? | Hallway |
| 3 | `turns.html` | Does it know left from right? | Hallway |
| 4 | `qr.html` | Do codes scan fast in dim light? | Wheatley |
| 5 | `graph.html` | Does the dot follow me? **Go / no-go.** | Wheatley |

Run **1** first. If it fails, nothing else matters.

Then use the **recorder** before tuning anything. One 90-second walk gives you a file
you can replay fifty times through `analyze.mjs` — otherwise every parameter change
means another trip down the hallway, and the schedule evaporates.

## Posture

Hold the phone **flat, screen up**, like you're following directions.

Gyro yaw only equals your walking direction in that posture. In a pocket or swinging at
your side the numbers are meaningless. That's a known limit of the approach, not a bug —
and confirming it is part of Test 2.

## Pass criteria

| Test | Pass |
|---|---|
| 1 | `devicemotion` fires at **≥30 Hz**, accel and `rotationRate` both non-null |
| 2 | **≤5% error** over 100 steps, at normal and slow pace |
| 3 | All turns detected, **direction correct every time**, loop closes within ±30° |
| 4 | Decodes in **under 2 s** from 1 m at 45°, in real hallway lighting |
| 5 | Dot lands **within 5 m** of truth after ~50 m and one corner |

Test 3 cares only about direction. Being off by 20° on an angle is fine — the real app
snaps heading to the corridor's true bearing at every junction, which is what stops gyro
drift accumulating.

Test 5 has a second, subtler criterion: **the drift circle should roughly cover the real
error.** A dot that's wrong but honest about it is fine, because the app can ask for a
rescan. A dot that's wrong and confident is the dangerous failure.

## If something fails

| Fails | What we do |
|---|---|
| 1 | No web blue dot on iPhone. Decide: native app, or ship without one |
| 2 | More QR anchors, shorter gaps between re-anchors |
| 3 | Drop free tracking — user taps to confirm each turn |
| 4 | Bigger codes, better placement, or NFC tags |
| 5 | **Ship the floor:** searchable map + written directions, no live dot |

That last row is the safety net. Even total failure leaves a genuinely useful app.

## Running it

Deployed on Vercel — sensors require HTTPS, so `localhost` alone won't work from a phone.

Locally, for editing:

```bash
npx serve . -l 3000
```

…then tunnel it so the phone can reach it over HTTPS:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

## Analysing a recording

```bash
node probes/analyze.mjs walk-01.json
```

Score it against steps you counted out loud:

```bash
node probes/analyze.mjs walk-01.json --truth 100
```

Let it search for the best thresholds:

```bash
node probes/analyze.mjs walk-01.json --truth 100 --sweep
```

When step error lands under 5%, it writes `probes/tuned.json`. That file is the entire
deliverable of Phase 0.

## Files

```
core.mjs      pure math — shared by the browser AND the analyser, so both agree
ui.mjs        browser-only: permissions, sample-rate meter, DOM helpers
analyze.mjs   Node replay + threshold sweep
*.html        one page per test
```

`core.mjs` imports nothing. That's deliberate: the detector you tune at your desk is
byte-for-byte the one running on your phone.
