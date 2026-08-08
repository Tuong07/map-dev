// Generates the fake building the app is built against.
//
// Deliberately NOT Wheatley. Room numbers are T-prefixed so nothing here can ever
// be mistaken for real survey data, and the layout is small enough to hold in your
// head while debugging a route.
//
// It's generated rather than hand-typed because edge lengths and lat/lons are
// derived values -- see CLAUDE.md. The layout below is authored in metres, which
// is readable; the coordinates come out of it.
//
//   npm run data:test-building

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toLatLon, distance, type Point } from '../lib/core/geo';
import type { Anchor, Edge, Node, Room } from '../lib/core/types';

// Somewhere harmless in Boston Harbor -- close enough to UMB that the numbers look
// plausible, far enough that nobody mistakes it for a surveyed building.
const ORIGIN = { lat: 42.3100, lon: -71.0400 };
const FLOOR_HEIGHT = 4.2;

const nodes: Node[] = [];
const edges: Edge[] = [];
const rooms: Room[] = [];
const anchors: Anchor[] = [];

const at = new Map<string, Point>();

function node(id: string, p: Point, floor: number, type: Node['type'], vertical?: string) {
  const ll = toLatLon(p, ORIGIN);
  nodes.push({
    id,
    lat: +ll.lat.toFixed(7),
    lon: +ll.lon.toFixed(7),
    floor,
    elevation: (floor - 1) * FLOOR_HEIGHT,
    type,
    ...(vertical ? { vertical } : {}),
  });
  at.set(id, p);
  return id;
}

/** Length is measured, never typed -- that's the point of generating this. */
function edge(from: string, to: string, kind: Edge['kind']) {
  const a = at.get(from)!;
  const b = at.get(to)!;
  const meters = kind === 'stair' || kind === 'elevator' ? FLOOR_HEIGHT : distance(a, b);
  edges.push({ id: `${from}__${to}`, from, to, meters: +meters.toFixed(2), kind });
}

function room(number: string, name: string, floor: number, doorNodeId: string) {
  rooms.push({ number, name, floor, doorNodeId });
}

/**
 * One floor: a straight spine running east, a short side corridor at the middle
 * leading to the stairs and lift, doors alternating either side of the spine.
 */
function buildFloor(floor: number, doors: { offset: number; side: 1 | -1; name: string }[]) {
  const F = `T${floor}`;
  const spine: string[] = [];

  // Spine: 7 nodes, 10 m apart. The middle one is the junction to the side corridor.
  for (let i = 0; i < 7; i++) {
    const id = node(`${F}-N${String(i + 1).padStart(3, '0')}`, { x: i * 10, y: 0 }, floor,
      i === 3 ? 'junction' : 'corridor');
    spine.push(id);
    if (i > 0) edge(spine[i - 1], id, 'hallway');
  }

  // Side corridor north from the junction, ending at a landing.
  const landing = node(`${F}-N008`, { x: 30, y: 15 }, floor, 'junction');
  edge(spine[3], landing, 'hallway');

  const stair = node(`${F}-S1`, { x: 25, y: 15 }, floor, 'stair', 'STAIR 1');
  const lift = node(`${F}-L1`, { x: 35, y: 15 }, floor, 'elevator', 'LIFT 1');
  edge(landing, stair, 'hallway');
  edge(landing, lift, 'hallway');

  // Doors hang off the spine, 3 m to one side.
  doors.forEach((d, i) => {
    const nearest = spine[Math.round(d.offset / 10)];
    const id = node(`${F}-D${String(i + 1).padStart(3, '0')}`,
      { x: d.offset, y: 3 * d.side }, floor, 'door');
    edge(nearest, id, 'door');
    room(`T${floor}-${String((i + 1) * 2).padStart(3, '0')}`, d.name, floor, id);
  });

  return { spine, stair, lift };
}

// ---------------------------------------------------------------------------

const f1 = buildFloor(1, [
  { offset: 10, side: 1, name: 'Lecture Hall' },
  { offset: 10, side: -1, name: 'Seminar Room' },
  { offset: 20, side: 1, name: 'Computer Lab' },
  { offset: 20, side: -1, name: 'Study Space' },
  { offset: 40, side: 1, name: 'Advising Office' },
  { offset: 40, side: -1, name: 'Classroom' },
  { offset: 50, side: 1, name: 'Quiet Room' },
]);

const f2 = buildFloor(2, [
  { offset: 10, side: 1, name: 'Physics Lab' },
  { offset: 20, side: -1, name: 'Faculty Office' },
  { offset: 40, side: 1, name: 'Classroom' },
  { offset: 40, side: -1, name: 'Conference Room' },
  { offset: 50, side: -1, name: 'Storage' },
]);

// Two entrances, so choosing a starting point is a real decision.
const west = node('T1-E001', { x: -6, y: 0 }, 1, 'entrance');
const east = node('T1-E002', { x: 66, y: 0 }, 1, 'entrance');
edge(west, f1.spine[0], 'hallway');
edge(east, f1.spine[6], 'hallway');

// The vertical links. Same `vertical` label on both floors is what ties them.
edge(f1.stair, f2.stair, 'stair');
edge(f1.lift, f2.lift, 'elevator');

// QR anchors. Bearing and height are recorded now because re-surveying is
// expensive and AR needs them -- see docs/AR.md.
anchors.push(
  { id: 'T1-A01', nodeId: west, facingBearing: 90, heightMeters: 1.5 },
  { id: 'T1-A02', nodeId: f1.spine[3], facingBearing: 0, heightMeters: 1.5 },
  { id: 'T2-A01', nodeId: f2.spine[3], facingBearing: 0, heightMeters: 1.5 },
);

// ---------------------------------------------------------------------------

const out = join(process.cwd(), 'data', 'test-building');
mkdirSync(out, { recursive: true });

const meta = {
  id: 'test-building',
  name: 'Testwood Hall (fake)',
  origin: ORIGIN,
  floors: [1, 2],
};

const write = (name: string, value: unknown) => {
  writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n');
  const count = Array.isArray(value) ? value.length : 1;
  console.log(`  ${name.padEnd(14)} ${String(count).padStart(3)} ${Array.isArray(value) ? 'entries' : ''}`);
};

console.log('\n  Testwood Hall (fake) -> data/test-building/\n');
write('meta.json', meta);
write('nodes.json', nodes);
write('edges.json', edges);
write('rooms.json', rooms);
write('anchors.json', anchors);
console.log('');
