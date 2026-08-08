# Data model

Four JSON files per building, in `data/wheatley/`. Everything is real-world
coordinates so it stays useful for AR later.

## Node

A point in the walkable network. Corridors are chains of nodes; rooms attach to one.

```ts
type Node = {
  id: string;          // "W1-N014"  building-floor-sequence
  lat: number;
  lon: number;
  floor: number;       // 1, 2, ...
  elevation: number;   // metres above the ground-floor datum
  type: 'corridor' | 'junction' | 'door' | 'stair' | 'entrance';
};
```

`elevation` looks redundant next to `floor`, but AR needs a real height to place
anything, and floor-to-floor spacing isn't uniform. Record it once while tracing.

## Edge

A walkable connection. Undirected — people walk hallways both ways.

```ts
type Edge = {
  id: string;
  from: string;        // Node id
  to: string;
  meters: number;      // COMPUTED from coordinates, never hand-entered
  kind: 'hallway' | 'stair' | 'door';
};
```

`meters` is derived, not authored. Hand-entered lengths drift out of sync with
geometry and produce routes that are wrong in ways that are hard to see.

## Room

A destination.

```ts
type Room = {
  number: string;      // "W-1-025"  as printed on the door
  name?: string;       // "Lecture Hall"
  floor: number;
  doorNodeId: string;  // where a route ends
  polygon?: [number, number][];   // lat/lon outline, for highlighting
};
```

`number` is what people type and must match the physical door plate exactly,
including punctuation. Search normalises; the data stays literal.

## Anchor

A printed QR sticker. Resets position, floor, and heading when scanned.

```ts
type Anchor = {
  id: string;          // "W1-J07" -- encoded in the QR, keep it SHORT
  nodeId: string;
  facingBearing: number;   // degrees; direction the reader faces when scanning
  heightMeters: number;    // mounting height off the floor
};
```

`facingBearing` and `heightMeters` are the two fields that feel like overkill while
you're taping stickers to a wall. They're exactly what AR needs to place an arrow.
Record them.

## Conventions

**Ids** are `W{floor}-{type}{seq}` — `W1-N014`, `W1-J07`. Readable in a debugger,
sortable, and obviously wrong when a floor is mismatched.

**Bearings** are degrees clockwise from north, 0–360.

**Undirected edges** — the router walks them both ways. Don't duplicate.

**Stairs** connect nodes on different floors with `kind: 'stair'`. They carry a
routing penalty so the router doesn't send people up and back down pointlessly.

## Validation

`npm run validate` fails the build on:

- a node in no edge (orphan)
- a room whose `doorNodeId` doesn't exist
- a room unreachable from any entrance
- an edge longer than 100 m or shorter than 0.5 m (almost always a mis-click)
- duplicate room numbers
- an anchor pointing at a missing node

These are the mistakes tracing actually produces. Each one is invisible on the map
and produces a confusing bug three days later, so they fail loudly at build time.
