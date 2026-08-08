# How the blue dot works

## Why we can't use anything off the shelf

GPS doesn't work indoors. Every commercial indoor positioning product — Oriient,
IndoorAtlas, Situm — needs sensors iOS Safari refuses to expose:

| Sensor | Android Chrome | iOS Safari | Needed for |
|---|---|---|---|
| Raw magnetometer | yes | **no** | geomagnetic fingerprinting |
| Bluetooth | yes | **no** | BLE beacons |
| WiFi scanning | no | **no** | WiFi fingerprinting |
| WebXR AR | yes | **no** | camera/visual tracking |

Apple declined all of them on privacy grounds, and every iOS browser is required to
use WebKit — so there's no browser you could switch to. Confirmed on the actual
device: `navigator.xr` doesn't even exist.

What's left is the accelerometer, the gyroscope, a camera, and one structural
advantage.

## The idea

**A person in a hallway cannot walk through a wall.**

So don't estimate a free 2D position. Estimate *how far along which corridor
segment* someone is. That turns an unsolvable problem into a 1-D one with error
bounded by the building's own geometry.

```
QR scan  ->  exact position, floor, heading
steps    ->  distance travelled
gyro     ->  which way they turned
graph    ->  snaps it all back onto real corridors
```

## State

```ts
type Fix = {
  edgeId: string;
  t: number;                  // 0..1 along that edge
  heading: number;            // degrees
  floor: number;
  metersSinceAnchor: number;  // drives the confidence circle
};
```

Position is never free-floating `(x, y)`. It is always "which edge, how far along".

## The trick that makes it work

At every junction, throw away the drifted gyro estimate and replace it with the
surveyed bearing of the hallway you just entered:

```ts
fix.edgeId = next;
fix.heading = graph.edgeBearing(next);   // <- drift dies here
```

Gyro drift never accumulates past one corridor segment. You don't need a good
compass or a good gyro — you need corridors, and the building has those.

## Honest uncertainty

Draw the dot with a circle that grows as `0.1 x metersSinceAnchor`. Past ~15 m,
prompt "scan a code to re-center".

This is the most important UX decision in the app. It makes drift read as the app
being self-aware rather than broken, and turns re-anchoring into something
purposeful instead of a chore. **A dot that's wrong but honest is fine. A dot
that's wrong and confident is dangerous.**

## What Phase 0 proved

Tests 1–3 pass on a real iPhone 17 Pro. Along the way they exposed five bugs that
would each have been near-impossible to find later, buried under UI:

| Finding | Consequence |
|---|---|
| Sensors run at 60 Hz | ~35 samples per step. Plenty |
| Gyro axes don't follow the W3C spec | This device reports body rotation in `gamma`, not `alpha`. Reading the spec axis lost turns entirely |
| Gyro bias is per-axis | A single scalar correction only cancels at the tilt it was measured at |
| Walking never stops rotating | Arm swing hits 60–70 deg/s, so "wait for rotation to settle" never fires. Measure NET rotation over a 1 s window instead — one full body sway, so oscillation cancels |
| Accelerometer is gravity **plus motion** | Using it raw makes "down" lurch once per step. Low-pass it first |
| Fixed step thresholds fail on gentle walking | Walking while watching the screen produced 12 steps in 38 s. Not degraded — nearly nothing. The threshold must scale to effort |

The gyro axis mapping is resolved at runtime from physics rather than a
per-platform table. As a device rotates, gravity measured in device coordinates
rotates the opposite way:

```
dg/dt = -(omega x g)
```

Both sides are measurable, so each candidate mapping is scored against observed
data and the winner kept. On real data it wins by ~4x, and it stays correct on
hardware that doesn't exist yet.

## Tuned constants

```
step detection      adaptive threshold, k = 1.2, floor 0.3 m/s^2
step min gap        280 ms
step smoothing      0.25
stride              0.70 m        <- MEASURE THIS PER USER
turn threshold      50 deg
turn window         1000 ms       <- one full body sway at walking cadence
turn settle         15 deg
gravity filter      0.7 s
axis mapping        auto-detected, locks after 15 rotating samples
drift circle        0.1 x metres since anchor
```

## Known limits

- Needs the phone held flat, screen up. Pocket carry is unusable — detect it and
  pause rather than reporting nonsense.
- Drifts on long straight runs; re-anchor every ~15 m of uncertainty.
- Can miss a turn in a crowd.
- Stride is per-person. The default 0.70 m is a guess until measured.
- Stairs: step count confirms climbing, but stride doesn't apply — a tread is
  ~0.28 m. The graph supplies the floor change instead.

## If Test 5 fails

Ship without the dot. Search, map, routing, and written turn-by-turn are all
independent of positioning, and that app is still better than what exists today.
