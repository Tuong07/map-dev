# Observed data

Every number here was measured, not estimated. Where a figure came from a
simulation rather than hardware, it says so.

Test device: **iPhone 17 Pro, iOS 26.5.2**, browser engine WebKit.
Building: **UMass Boston Wheatley Hall**, plans dated Dec 2023 (L1) / Jul 2024 (L2).

---

## 1. What the phone can and cannot do

Measured by `probes/sensors.html`.

| Capability | Result | Consequence |
|---|---|---|
| `devicemotion` sample rate | **60 Hz** | ~35 samples per step. Ample |
| Accelerometer at rest | **9.8 m/s²** | Calibrated, reporting real units |
| Gyroscope at rest | ~0 °/s | Low bias, usable |
| `navigator.xr` (WebXR AR) | **absent** | Browser AR impossible on iOS |
| `BarcodeDetector` | **absent** | QR decoding falls back to jsQR |

The two absences are platform decisions by Apple, not gaps in the code. Every
iOS browser is required to use WebKit, so there is no browser to switch to.
Combined with the missing magnetometer and Bluetooth APIs, this rules out every
commercial indoor-positioning SDK (Oriient, IndoorAtlas, Situm) for a web app.

---

## 2. Step detection

### Live walks (real hardware)

| Walk | Detected | Actual | Error |
|---|---|---|---|
| Normal pace, phone in hand | 104 | 100 | **+4.0%** |
| Slow, screen-watching | 95 | 100 | **−5.0%** |
| Stairs up | 15 | 14 | +7.1% |
| Stairs down | 16 | 16 | **0%** |
| **Total** | **230** | **230** | **0%** |

Net zero across all four walks — the threshold is well centred, and the error is
variance rather than bias. Fast walking over-counts (one stride producing two
peaks); slow walking under-counts (peaks falling below threshold). One fixed
threshold cannot serve both gaits.

Stairs were expected to be the worst case and were not, so no special handling
is needed. Note that stride length does **not** apply on stairs — a tread is
~0.28 m against a 0.70 m walking stride — but the graph supplies the floor
change, so step count only has to confirm climbing.

### Fixed vs adaptive threshold (simulated gaits)

The live walks hid a failure that only shows at gentle cadences. Replaying a
recorded walk showed the median acceleration magnitude at **9.82 m/s²** against
gravity's 9.81 — only **5.9%** of samples ever reached the fixed 11.0 threshold.
It found 12 steps in 38 s, a cadence of 19/min against a normal 100–120.

| Amplitude | Cadence | True steps | Fixed 11.0 | Adaptive |
|---|---|---|---|---|
| 0.35 | 84/min | 42 | **0** | 40 |
| 0.5 | 96/min | 48 | **0** | **48** |
| 1.0 | 108/min | 54 | **0** | **54** |
| 2.0 | 120/min | 60 | 60 | 60 |
| 3.5 | 132/min | 66 | 66 | 66 |

Fixed thresholds do not degrade gracefully at low effort — they return nothing.
That matters because walking slowly while watching the screen is exactly how
someone uses a navigation app.

### False-positive checks (adaptive, 30 s each)

| Condition | Steps detected |
|---|---|
| Perfectly still | 0 |
| Still + sensor noise | 0 |
| Still + hand tremor (8 Hz) | 0 |
| Phone set down / picked up | 1 |
| 15 s still, then 15 s gentle walk | 0, then **25** (true 25) |

---

## 3. Turn detection

### Live square walk (real hardware)

Four right turns around a rectangle, returning to the start.

```
turns    R 82°   R 82°   R 84°   R 97°
sum      −345°   (target −360°)
samples  2138    peak rate 224 °/s
bias     α −0.019   β 0.136   γ 0.034
```

All four turns detected, every direction correct, loop closing within 15°.

### The bug this exposed

Before the fix, the same walk produced **0 turns and −10° of yaw** while the
gyroscope was recording a peak of 71 °/s. Replaying the recorded trace and
testing every possible way of extracting heading:

| Method | Net rotation | Largest 2 s swing |
|---|---|---|
| raw `alpha` only | 6° | 11° |
| **raw `gamma` only** | **−354°** | **98°** |
| projection on smoothed gravity | −10° | 12° |

The turns were in `gamma`. The W3C spec says rotation about the device Z axis —
the one aligned with gravity when the phone is flat — is reported in `alpha`.
**This device does not follow the spec.**

### Runtime axis resolution

Rather than hardcoding a per-device table, the mapping is derived from physics.
As a device rotates, gravity measured in device coordinates rotates the opposite
way:

```
dg/dt = −(ω × g)
```

Both sides are measurable, so each candidate mapping can be scored by how well
it predicts the observed gravity motion.

| Candidate mapping | Prediction error |
|---|---|
| spec `(beta, gamma, alpha)` | 2912 |
| **altA `(alpha, beta, gamma)`** | **711** |
| altB `(gamma, beta, alpha)` | 2845 |
| altC `(beta, alpha, gamma)` | 751 |

The correct mapping wins by roughly **4×**. Gating on samples where the device is
genuinely rotating (>45 °/s) sharpens the separation further, since a stationary
device makes every mapping predict "gravity isn't moving."

### Replay: before and after

| | Turns | Total yaw |
|---|---|---|
| Spec mapping | 0 | −10° |
| Auto-resolved | **4 (R R R R)** | **−352°** |

### Turn classifier, simulated arm swing

Walking never stops rotating — a hand swinging at 60–70 °/s never settles below
a rate threshold, so the original "wait for rotation to stop" classifier never
fired. Measuring **net rotation over a 1-second window** instead works because a
1 Hz body sway completes a full cycle in that window and cancels, while a real
turn accumulates.

| Arm swing | Turns found | Total |
|---|---|---|
| 0 °/s | 4 (R R R R) | −360° |
| 20 °/s | 4 (R R R R) | −357° |
| 50 °/s | 4 (R R R R) | −366° |
| 80 °/s | 4 (R R R R) | −361° |

Parameter sweep across amplitudes 0–100 °/s and cadences 0.8/1.0/1.3 Hz:
the 1000 ms window passes **18 of 18** cases; a 600 ms window passes 16.

---

## 4. Map data extraction (OCR)

Apple Vision framework via Swift, on 300 dpi renders of the architectural PDF.

| | Level 1 | Level 2 |
|---|---|---|
| Rooms recovered | **80** | **130** |
| Sub-numbered rooms (`2-142-3`) | 0 | 21 |
| Scale from scale bar | **33.96 px/m** | **34.17 px/m** |
| Low-confidence reads | 2 (`1-055`, `1-077V`) | 0 |
| Source image | 5100 × 3300 | 5100 × 3300 |

**Scale cross-check:** the two pages were processed independently and agree to
within **0.6%**. That is a useful correctness signal — nothing forces them to
match.

**Two techniques mattered.** Vision downscales large images internally, erasing
6 pt room labels, so pages are fed in as overlapping tiles at full resolution.
And every label sits inside a thin rectangle that OCR reads as bracket
characters — `[1-090]`, `[1-077Y]]` — so those are stripped before pattern
matching. Recovery on Level 1 went from **30 rooms to 80** once both were
handled.

**Independent count check:** 99 area labels (`NNN SF`) were detected on Level 1,
one per room, against 80 room numbers recovered — an 81% recovery rate on a
floor whose smallest labels are near the limit of the render resolution.

Room types are read from the drawing too: Level 1 is 32 offices, 26 classrooms,
and 22 service spaces (mechanical, electrical, restrooms, lobbies).

---

## 5. Corridor network fragmentation

The most instructive bug in the project, because it is invisible.

Hand-traced corridors that *appear* to cross on screen do not share a node
unless clicked exactly. The Level 1 map looked complete and was in **13
disconnected pieces**.

| | Before | After |
|---|---|---|
| Connected components | **13** | **1** |
| Rooms per island | 26, 19, 8, 8, 5, 4, 3, 3, 2, 2 | 80 |
| Routable room pairs | **1152 / 6320 (18.2%)** | **6320 / 6320 (100%)** |

A route between two randomly chosen rooms failed **82%** of the time, on a map
that looked finished.

### Stitching

Joins are chosen geometrically: repeatedly find the closest approach between any
two disconnected pieces and join there, splitting the target corridor so the
junction lands exactly on it.

```
gap distribution (m):  0.0  0.0  0.0  0.1  0.1  0.2  0.3  0.4  0.7  1.7  2.4  2.4
                     | 2.7 … 5.5 |  7.1  |  12.6  13.5
```

Merging 13 islands needs 12 joins, and the 12 smallest gaps are all **under
2.5 m** — unambiguously corridors meant to touch. The distribution then breaks
to 7.1 m and 12.6 m, which are genuinely separate spaces. A distance cap stops
the algorithm inventing a path through a wall.

Applied: **12 joins, largest 4.97 m**, seven of them under 0.25 m.

---

## 6. Current map, Level 1

| | |
|---|---|
| Nodes | **132** — 34 corridor, 11 junction, 7 stair, 80 door |
| Edges | **132** |
| Rooms linked | **80 / 80** |
| Connected components | **1** |
| Edge length | min 0.0 m · median 2.9 m · max 13.4 m |

---

## 7. Routing performance

Every ordered pair of rooms on Level 1, routed with the hand-written A\*.

| | |
|---|---|
| Room pairs tested | **6,320** |
| Routable | **6,320 (100%)** |
| Failed | 0 |
| Route length | min 0.0 m · median **65.9 m** · max **178.6 m** |
| Total time | **71 ms** |
| Per route | **0.011 ms** |

A median route of 66 m across a building 150 m long is a plausible figure — it
implies most trips cross a meaningful part of the floor rather than hopping
between neighbours.

At 11 microseconds per route there is no case for computing paths on a server.

---

## 8. Test suite

```
lib/core/__tests__/autolink.test.ts    5 tests
lib/core/graph.test.ts                17 tests
                                      ──────────
                                      22 passed
```

Coverage is deliberately narrow: pathfinding and positioning geometry only.
That is where bugs with real consequences live.

---

## Not yet measured

Stated plainly so nothing here is mistaken for a finished result.

- **Test 4 (QR scan timing)** — needs printed codes in Wheatley's real lighting
- **Test 5 (end-to-end position tracking)** — the go/no-go for the live blue dot
- **Level 2 corridors** — rooms extracted, corridors not traced
- **Georeferencing** — distances are real; the building's position and rotation
  on Earth are placeholders
- **Real users** — no field usage yet
