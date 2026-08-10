// Stitches a fragmented corridor network back into one connected graph.
//
//   npx tsx scripts/join-islands.ts --floor 1 [--cap 6] [--dry]
//
// Hand-traced corridors routinely end up as separate networks: two hallways are
// drawn so they cross on screen, but nothing makes them share a node, so the map
// looks finished while routing fails between them. Level 1 was drawn as 13
// islands with only 18% of room pairs reachable.
//
// The fix is geometric, not visual. Repeatedly find the closest approach between
// any two disconnected pieces and join there, splitting the target corridor so
// the junction sits exactly on it. Only gaps under `cap` metres are joined --
// a large gap means there is genuinely no corridor between them, and inventing
// one would route people through a wall.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
};
const FLOOR = arg('floor', '1');
const BUILDING = arg('building', 'wheatley');
const CAP_M = parseFloat(arg('cap', '6'));
const DRY = process.argv.includes('--dry');

type N = { id: string; x: number; y: number; type: string; vertical?: string };
type E = { id: string; from: string; to: string; kind: string };

const dir = join('data', BUILDING, `level-${FLOOR}`);
const tracePath = join(dir, 'trace.json');
if (!existsSync(tracePath)) { console.error(`  no ${tracePath}`); process.exit(1); }

const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
const ppm = JSON.parse(readFileSync(join(dir, 'rooms.raw.json'), 'utf8')).pixelsPerMetre;

const nodes: N[] = [...trace.nodes];
let edges: E[] = [...trace.edges];

/** Which island each node is on. Recomputed after every join. */
function components(): Map<string, number> {
  const adj = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const e of edges) { adj.get(e.from)?.push(e.to); adj.get(e.to)?.push(e.from); }
  const of = new Map<string, number>();
  let c = 0;
  for (const n of nodes) {
    if (of.has(n.id)) continue;
    const stack = [n.id];
    while (stack.length) {
      const x = stack.pop()!;
      if (of.has(x)) continue;
      of.set(x, c);
      for (const y of adj.get(x) ?? []) if (!of.has(y)) stack.push(y);
    }
    c++;
  }
  return of;
}

const byId = () => new Map(nodes.map((n) => [n.id, n]));

/** Closest point on segment a-b to p, clamped to the segment. */
function project(p: N, a: N, b: N) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  if (!L) return { d: Math.hypot(p.x - a.x, p.y - a.y), t: 0, pt: { x: a.x, y: a.y } };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L;
  t = Math.max(0, Math.min(1, t));
  const pt = { x: a.x + t * dx, y: a.y + t * dy };
  return { d: Math.hypot(p.x - pt.x, p.y - pt.y), t, pt };
}

let seq = nodes.filter((n) => n.id.startsWith('J')).length;
const joins: { from: string; onto: string; metres: number; split: boolean }[] = [];

for (let pass = 0; pass < 200; pass++) {
  const of = components();
  const islandCount = new Set(of.values()).size;
  if (islandCount <= 1) break;

  const map = byId();
  let best: { node: N; edge: E; t: number; pt: { x: number; y: number }; d: number } | null = null;

  for (const n of nodes) {
    const cn = of.get(n.id)!;
    for (const e of edges) {
      if (of.get(e.from) === cn) continue;          // same island already
      const a = map.get(e.from), b = map.get(e.to);
      if (!a || !b) continue;
      const r = project(n, a, b);
      if (!best || r.d < best.d) best = { node: n, edge: e, t: r.t, pt: r.pt, d: r.d };
    }
  }

  if (!best || best.d / ppm > CAP_M) break;         // remaining gaps are real

  // Land the junction on the existing corridor. If the closest point is
  // effectively an endpoint, reuse that node rather than splitting a hair off.
  const map2 = byId();
  let targetId: string;
  let didSplit = false;
  if (best.t < 0.02) targetId = best.edge.from;
  else if (best.t > 0.98) targetId = best.edge.to;
  else {
    const j: N = { id: `J${String(++seq).padStart(3, '0')}`, x: best.pt.x, y: best.pt.y, type: 'junction' };
    nodes.push(j);
    edges = edges.filter((e) => e.id !== best!.edge.id);
    edges.push(
      { id: best.edge.id + 'a', from: best.edge.from, to: j.id, kind: best.edge.kind },
      { id: best.edge.id + 'b', from: j.id, to: best.edge.to, kind: best.edge.kind },
    );
    targetId = j.id;
    didSplit = true;
  }

  if (targetId !== best.node.id) {
    edges.push({ id: `EJ${String(seq).padStart(3, '0')}`, from: best.node.id, to: targetId, kind: 'hallway' });
  }
  joins.push({ from: best.node.id, onto: targetId, metres: best.d / ppm, split: didSplit });
}

const finalOf = components();
const finalIslands = new Set(finalOf.values()).size;

console.log(`  ${joins.length} joins made:`);
for (const j of joins) {
  console.log(`    ${j.from.padEnd(6)} -> ${j.onto.padEnd(6)} ${j.metres.toFixed(2).padStart(6)} m${j.split ? '  (split)' : ''}`);
}
console.log(`  islands: 13 -> ${finalIslands}`);
console.log(`  nodes: ${trace.nodes.length} -> ${nodes.length}   edges: ${trace.edges.length} -> ${edges.length}`);

if (DRY) { console.log('  --dry, nothing written'); process.exit(0); }

copyFileSync(tracePath, join(dir, 'trace.beforejoin.json'));
// Doors are derived from the edges we just changed, so they must be rebuilt.
// Clearing them forces a clean Auto-link rather than leaving stale geometry.
writeFileSync(tracePath, JSON.stringify(
  { nodes, edges, doors: [], doorEdges: [], roomDoor: {} }, null, 2) + '\n');
console.log(`  wrote ${tracePath}  (backup: trace.beforejoin.json)`);
console.log('  open the tracer, click Auto-link doors, then Save.');
