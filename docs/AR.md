# AR

Phase 2. Designed now because two decisions in the MVP depend on it.

## What it is

Camera view, with a floating arrow showing which way to walk and how far. Google
Maps Live View, at hallway scale.

## What's possible on iPhone, and what isn't

Confirmed on the actual device — `navigator.xr` doesn't exist:

| | iOS Safari | Anchored in 3D | Cost |
|---|---|---|---|
| WebXR | **never** | — | — |
| Floating arrow (ours) | yes | no | free, ~half a day |
| Marker-based (AR.js) | yes | while marker visible | free, ~2 days |
| Zapworks | yes | yes | $2,640/yr |
| Native app | n/a | fully | $99/yr + App Store friction |

8th Wall shut down in February 2026, so the cheap commercial option is gone.

**We build the floating arrow.** It's what was actually wanted, and it happens to
be the cheapest.

## The key realisation

**AR.js does not draw the arrow.** A camera feed with something on top is a
`<video>` element with a `<div>` over it — the browser has always done that.

AR.js does exactly one job: working out the phone's 3D pose from a marker, so
content can stay pinned to a physical spot. A floating arrow isn't pinned to
anything, so it needs no library at all.

## How it works

The AR view renders data the map view already has:

```
where you are        Fix -> lat/lon        from POSITIONING.md
which way you face   heading                from POSITIONING.md
where you're going   next route waypoint    from the router
```

Every frame:

```ts
// 1. bearing from you to the next waypoint
const target = Math.atan2(wp.x - me.x, wp.y - me.y) * 180 / Math.PI;

// 2. how far off your current facing that is
const relative = normalize(target - myHeading);      // -180..180

// 3. where that lands on screen
const pxPerDeg = screenWidth / CAMERA_FOV;           // ~390px / 65deg = 6
const screenX  = screenWidth / 2 + relative * pxPerDeg;

// 4. vertical from phone pitch, so it sits on the horizon
const screenY  = screenHeight / 2 + pitch * pxPerDeg;
```

Step 3 is what sells it. Pan the phone right and `myHeading` grows, so `relative`
shrinks and the arrow slides **left** — staying locked to the same real-world
direction, exactly like Live View's chevrons. Nothing is being tracked visually;
the gyroscope alone produces the effect.

When `|relative| > FOV/2` the waypoint is off-screen, so pin an indicator to the
screen edge: "turn left".

## What it won't do

No depth. The arrow floats at fixed size rather than sitting on the floor 10 m
ahead, and it won't hide behind a wall. Those need true 3D pose — a visible marker
or ARKit.

In practice, someone walking a hallway with the phone up won't notice. The
horizontal behaviour is what reads as AR.

## What this costs the MVP now

Nothing to build. Three things to keep doing:

1. Store coordinates as **real-world lat/lon plus floor elevation** — not pixels
2. Record each anchor's **position, facing direction, and mounting height**
3. Keep routes as **geo waypoints**, not screen coordinates

All three are already in [DATA_MODEL.md](DATA_MODEL.md). Skip them and AR becomes
a rewrite instead of an addition.

## Later, if it's worth it

**Marker-based (AR.js).** Scan a code at a junction, an arrow paints itself on the
floor. Real 3D anchoring, but only while the code is in frame. Your QR stickers
already carry the position and bearing it needs.

**Occlusion via LiDAR.** With a mesh of the building, hide the arrow when a wall is
between you and it. An arrow that correctly disappears behind a corner and
reappears as you round it is the single biggest thing separating "looks fake" from
"looks real". iPhone 17 Pro can capture that mesh.

## What we're not doing

**Building our own visual positioning.** Matching camera frames against a
photogrammetric model — Google's approach — is 2–3 months, needs a GPU server, and
performs badly in corridors full of identical doors. A QR sticker gives the same
answer more reliably for an afternoon's work.

Google uses VPS because it cannot tape a code to every street corner on Earth.
We can tape fifteen to Wheatley.
