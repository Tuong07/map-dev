'use client';

// The map editor. Desktop only, development only -- see docs/ARCHITECTURE.md.
//
// Works entirely in IMAGE PIXELS while you draw, and converts to metres and
// lat/lon once, on save. Clicking is a pixel operation; converting on every
// click would just accumulate rounding error for no benefit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { autoLinkRooms, projectOntoSegment, type Segment } from '@/lib/core/autolink';

type Mode = 'corridor' | 'door' | 'stair' | 'elevator' | 'entrance' | 'select' | 'pan';

type TNode = {
  id: string;
  x: number;            // image pixels
  y: number;
  type: 'corridor' | 'junction' | 'door' | 'stair' | 'elevator' | 'entrance';
  vertical?: string;    // "STAIR 4" -- shared label links floors
  /** Door nodes only: the room this door belongs to, as typed. */
  room?: string;
  /** Door nodes only: display label -- "1-053 D1", "1-053 D2". */
  label?: string;
};
type TEdge = { id: string; from: string; to: string; kind: 'hallway' | 'stair' | 'elevator' | 'door' };

/**
 * What you draw is kept apart from what auto-link generates.
 *
 * `nodes`/`edges` are the skeleton -- only ever changed by clicking. `doors`,
 * `doorEdges` and `roomDoor` are derived, and auto-link throws them away and
 * rebuilds them from the skeleton every time.
 *
 * The first version mutated one shared graph: auto-link split the hallway edges
 * in place and left the door nodes behind. Running it a second time then treated
 * those door-to-door segments as fresh corridors AND restarted door numbering at
 * D001, so the new doors collided with the old ones -- self-edges, and 92 m
 * "corridors" spanning the whole building. Separating the two makes re-running
 * naturally idempotent instead of quietly destructive.
 */
type Graph = {
  nodes: TNode[];
  edges: TEdge[];
  /** Placed by hand in Door mode. Each carries the room it serves. */
  doors: TNode[];
  doorEdges: TEdge[];
};

/**
 * Which doors serve each room.
 *
 * Derived from the doors themselves rather than stored, because a room can have
 * several doors and keeping a second copy of that relationship is how the two
 * drift apart. The door node is the single source of truth.
 */
/**
 * "1-053 D1" for the first door on a room, "1-053 D2" for the next.
 *
 * The suffix is generated rather than typed: a hand-typed D2 on a room that has
 * no D1, or two doors both called D1, produces data that looks fine and breaks
 * quietly later.
 */
const nextDoorLabel = (g: Graph, room: string) =>
  `${room} D${g.doors.filter((d) => d.room === room).length + 1}`;

const roomDoors = (g: Graph): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const d of g.doors) {
    if (!d.room) continue;
    (out[d.room] ??= []).push(d.id);
  }
  return out;
};

type RawRoom = { number: string; type: string; px: { x: number; y: number }; confidence: number };
type Raw = {
  building: string; floor: number; origin: { lat: number; lon: number };
  image: { file: string; width: number; height: number };
  pixelsPerMetre: number; rooms: RawRoom[];
};

const EMPTY: Graph = { nodes: [], edges: [], doors: [], doorEdges: [] };

/** Everything drawn plus everything derived, for rendering and saving. */
const allNodes = (g: Graph) => [...g.nodes, ...g.doors];
/** Once doors exist they carry the split hallway chain, replacing the raw edges. */
const allEdges = (g: Graph) => (g.doorEdges.length ? g.doorEdges : g.edges);

/**
 * Re-thread the door chains after something moved or was deleted.
 *
 * Each corridor edge is walked through the doors sitting on it, in order:
 *   from -> D3 -> D7 -> D1 -> to
 * Move a door and that order can change; move a corridor point and a door may
 * now belong to a different edge entirely. Rather than patch the chain, work out
 * afresh which edge each door is nearest and rebuild every chain.
 *
 * Doors are NOT moved here -- only re-ordered and re-parented. Their coordinates
 * are whatever the drag left them at, which is what makes a drag stick.
 */
function rebuildDoorChains(g: Graph): Graph {
  if (!g.doors.length) return { ...g, doorEdges: [] };
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  const onEdge = new Map<string, { door: TNode; t: number }[]>();
  for (const d of g.doors) {
    let best: { edgeId: string; t: number; dist: number } | null = null;
    for (const e of g.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const p = projectOntoSegment(d, a, b);
      if (!best || p.distance < best.dist) best = { edgeId: e.id, t: p.t, dist: p.distance };
    }
    if (!best) continue;
    if (!onEdge.has(best.edgeId)) onEdge.set(best.edgeId, []);
    onEdge.get(best.edgeId)!.push({ door: d, t: best.t });
  }

  const doorEdges: TEdge[] = [];
  for (const e of g.edges) {
    const on = (onEdge.get(e.id) ?? []).sort((p, q) => p.t - q.t);
    let prev = e.from;
    for (const { door } of on) {
      doorEdges.push({ id: `E${e.id}-${door.id}`, from: prev, to: door.id, kind: e.kind });
      prev = door.id;
    }
    doorEdges.push({ id: `E${e.id}-end`, from: prev, to: e.to, kind: e.kind });
  }
  return { ...g, doorEdges };
}

/**
 * Older traces stored doors inside `nodes` and split the hallway edges in place.
 * Recover the skeleton: keep the drawn nodes, and reconnect any two of them that
 * were joined through a chain of door nodes.
 */
function migrate(t: any): Graph {
  if (!t) return EMPTY;
  if (Array.isArray(t.doors)) {
    // Doors used to record their room in a separate `roomDoor` map. Fold it onto
    // the door itself so there is one source of truth, and give each a label.
    const owner = new Map<string, string>();
    for (const [room, nodeId] of Object.entries(t.roomDoor ?? {})) owner.set(nodeId as string, room);
    const doors = (t.doors as TNode[]).map((d) => {
      const room = d.room ?? owner.get(d.id);
      return room ? { ...d, room, label: d.label ?? `${room} D1` } : d;
    });
    return { nodes: t.nodes ?? [], edges: t.edges ?? [], doors, doorEdges: t.doorEdges ?? [] };
  }

  // A trace written before the split had auto-link run more than once will
  // contain duplicate node ids. Adjacency is then ambiguous -- walking a chain
  // can step onto the wrong namesake -- and the "recovered" skeleton comes out
  // as diagonals crossing the building. Better to admit it is unrecoverable
  // than to hand back a plausible-looking wrong map.
  const ids = (t.nodes ?? []).map((n: TNode) => n.id);
  if (new Set(ids).size !== ids.length) return EMPTY;

  const drawn: TNode[] = (t.nodes ?? []).filter((n: TNode) => n.type !== 'door');
  const drawnIds = new Set(drawn.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of t.edges ?? []) {
    if (e.from === e.to) continue;                    // drop the self-edges
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }

  const edges: TEdge[] = [];
  const seenPair = new Set<string>();
  for (const start of drawn) {
    // Walk outward; any drawn node reachable only through doors was originally
    // a direct neighbour.
    for (const first of adj.get(start.id) ?? []) {
      let prev = start.id, cur = first, guard = 0;
      while (!drawnIds.has(cur) && guard++ < 500) {
        const next = (adj.get(cur) ?? []).find((x) => x !== prev);
        if (!next) break;
        prev = cur; cur = next;
      }
      if (!drawnIds.has(cur) || cur === start.id) continue;
      const key = [start.id, cur].sort().join('|');
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      edges.push({ id: `E${String(edges.length + 1).padStart(3, '0')}`, from: start.id, to: cur, kind: 'hallway' });
    }
  }
  return { nodes: drawn, edges, doors: [], doorEdges: [] };
}
const M_PER_DEG_LAT = 110540, M_PER_DEG_LON = 111320;

export default function TracerCanvas({ building, floor }: { building: string; floor: number }) {
  const [raw, setRaw] = useState<Raw | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph>(EMPTY);
  const [history, setHistory] = useState<Graph[]>([]);
  const [mode, setMode] = useState<Mode>('corridor');
  const [runFrom, setRunFrom] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [relinking, setRelinking] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, w: 5100, h: 3300 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  // `before` is the graph as it was when the gesture started, so the whole drag
  // undoes as one step instead of fifty.
  const drag = useRef<{ id: string; isDoor: boolean; before: Graph; moved: boolean } | null>(null);

  // --- load -----------------------------------------------------------------
  useEffect(() => {
    fetch(`/api/tracer?building=${building}&floor=${floor}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setRaw(d.raw);
        setView({ x: 0, y: 0, w: d.raw.image.width, h: d.raw.image.height });
        if (d.trace) {
          const g = migrate(d.trace);
          setGraph(g);
          setStatus(
            Array.isArray(d.trace.doors) ? 'Loaded saved trace'
            : g.nodes.length ? `Repaired old trace — ${g.nodes.length} points, re-run Auto-link`
            : 'Old trace was corrupted by the duplicate-id bug — starting fresh',
          );
        } else { setGraph(EMPTY); }
        setHistory([]);
      })
      .catch((e) => setError(String(e)));
  }, [building, floor]);

  const commit = useCallback((next: Graph, note = '') => {
    setHistory((h) => [...h.slice(-49), graph]);
    setGraph(next);
    if (note) setStatus(note);
  }, [graph]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      setGraph(h[h.length - 1]);
      setRunFrom(null);
      setStatus('Undo');
      return h.slice(0, -1);
    });
  }, []);

  /**
   * Remove the selected node. Select mode only, same as dragging.
   *
   * Deleting a door also unlinks its room, which puts the room back on the
   * problems list rather than leaving it pointing at a node that no longer
   * exists. Deleting a drawn node takes its edges with it -- an edge to nowhere
   * would strand everything downstream of it.
   */
  const deleteSelected = useCallback(() => {
    if (!selected || mode !== 'select') return;
    setGraph((g) => {
      const isDoor = g.doors.some((d) => d.id === selected);
      setHistory((h) => [...h.slice(-49), g]);
      if (isDoor) {
        // The door carries its own room, so removing it removes the link too.
        return rebuildDoorChains({ ...g, doors: g.doors.filter((d) => d.id !== selected) });
      }
      return rebuildDoorChains({
        ...g,
        nodes: g.nodes.filter((n) => n.id !== selected),
        edges: g.edges.filter((e) => e.from !== selected && e.to !== selected),
      });
    });
    setStatus(`Deleted ${selected}`);
    setSelected(null);
  }, [selected, mode]);

  // --- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
      if (e.key === 'Escape') { setRunFrom(null); setSelected(null); setRelinking(null); return; }
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelected(); return; }
      // Hold space to pan without leaving the drawing mode -- the convention in
      // every design tool, and it means you never lose your place mid-corridor.
      if (e.code === 'Space') { e.preventDefault(); setSpaceHeld(true); return; }
      const keys: Record<string, Mode> = {
        c: 'corridor', d: 'door', s: 'stair', e: 'elevator', n: 'entrance', v: 'select', h: 'pan',
      };
      if (keys[e.key]) { setMode(keys[e.key]); setRunFrom(null); }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    // A dropped keyup (tab away mid-drag) would leave panning stuck on forever.
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [undo, deleteSelected]);

  // --- coordinate helpers ---------------------------------------------------
  /**
   * Screen point -> image pixel.
   *
   * An <svg> with the default preserveAspectRatio scales the viewBox UNIFORMLY
   * and centres it, so unless the element happens to match the viewBox aspect
   * ratio there are bars down two sides. Mapping the element rect straight onto
   * the viewBox ignores those bars and skews every click -- about 3 m off near
   * the top and bottom edges here, while staying accurate in the middle, which
   * is exactly the kind of error you don't notice until the map is wrong.
   */
  const toImage = (evt: React.MouseEvent): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    const scale = Math.min(r.width / view.w, r.height / view.h);
    const padX = (r.width - view.w * scale) / 2;
    const padY = (r.height - view.h * scale) / 2;
    return {
      x: view.x + (evt.clientX - r.left - padX) / scale,
      y: view.y + (evt.clientY - r.top - padY) / scale,
    };
  };

  /**
   * Drawing only ever snaps to nodes YOU placed -- joining a corridor to a
   * generated door would put derived data back into the skeleton and undo the
   * separation. Re-linking is the exception: there you're choosing a door.
   */
  const nodeAt = (p: { x: number; y: number }, tolPx: number, includeDoors = false) =>
    (includeDoors ? allNodes(graph) : graph.nodes)
      .find((n) => Math.hypot(n.x - p.x, n.y - p.y) < tolPx);

  /**
   * Guess which room a door belongs to, from the OCR label positions.
   *
   * A door on a wall is usually much closer to its own room's label than to any
   * other, so the nearest label is right nearly always. The two cases where it
   * isn't are worth interrupting for:
   *
   *   ambiguous - two rooms nearly equally close, e.g. a door on the wall
   *               between them. The test is RELATIVE, not a fixed distance: a
   *               door into a large classroom can be 6 m from its own label and
   *               still unambiguous, while two small offices might both sit 2 m
   *               away. What matters is the gap between first and second place.
   *   tooFar    - nothing near enough for the guess to mean anything.
   */
  const AMBIGUOUS_RATIO = 1.25;
  const MAX_ROOM_DIST_M = 15;

  const nearestRoom = (p: { x: number; y: number }) => {
    if (!raw?.rooms.length) return null;
    const ranked = raw.rooms
      .map((r) => ({ room: r.number, d: Math.hypot(r.px.x - p.x, r.px.y - p.y) }))
      .sort((a, b) => a.d - b.d);
    const [best, second] = ranked;
    return {
      room: best.room,
      runnerUp: second?.room,
      tooFar: best.d / raw.pixelsPerMetre > MAX_ROOM_DIST_M,
      ambiguous: !!second && second.d < best.d * AMBIGUOUS_RATIO,
    };
  };

  /** Retype the room on an existing door. Double-click it in Select mode. */
  const renameDoor = (id: string) => {
    const door = graph.doors.find((d) => d.id === id);
    if (!door) return;
    const room = prompt('Room number for this door', door.room ?? '')?.trim();
    if (!room) return;
    commit({
      ...graph,
      doors: graph.doors.map((d) =>
        d.id === id ? { ...d, room, label: `${room} D1` } : d),
    }, `${id} → ${room}`);
  };

  // --- drawing --------------------------------------------------------------
  const onClick = (evt: React.MouseEvent) => {
    if (!raw || pan.current) return;
    const p = toImage(evt);
    const tol = (view.w / 1000) * 12;
    const hit = nodeAt(p, tol, !!relinking);

    if (relinking) {
      // Second click of a re-link: reassign an existing door to this room.
      const door = hit && graph.doors.find((d) => d.id === hit.id);
      if (!door) { setStatus('Click a door to reassign it to this room'); return; }
      commit({
        ...graph,
        doors: graph.doors.map((d) =>
          d.id === door.id ? { ...d, room: relinking, label: nextDoorLabel(graph, relinking) } : d),
      }, `${relinking} re-linked`);
      setRelinking(null);
      return;
    }

    if (mode === 'door') {
      const guess = nearestRoom(p);
      let room = guess?.room;
      // Only interrupt when the guess isn't trustworthy: two rooms almost
      // equally close, or nothing close at all.
      if (!guess || guess.ambiguous || guess.tooFar) {
        const why = !guess || guess.tooFar
          ? 'No room close by — type the room number'
          : `Too close to call between ${guess.room} and ${guess.runnerUp} — type the room number`;
        room = prompt(why, guess?.room ?? '')?.trim();
      }
      if (!room) return;
      const node: TNode = {
        id: nextId(graph, 'D'), x: p.x, y: p.y, type: 'door',
        room, label: nextDoorLabel(graph, room),
      };
      commit({ ...graph, doors: [...graph.doors, node] }, `${node.label} placed`);
      return;
    }

    if (mode === 'select') { setSelected(hit?.id ?? null); return; }

    if (mode === 'stair' || mode === 'elevator' || mode === 'entrance') {
      const label = mode === 'entrance' ? '' :
        (prompt(`${mode === 'stair' ? 'Stair' : 'Lift'} label (must match on other floors)`,
          mode === 'stair' ? 'STAIR 1' : 'LIFT 1') ?? '');
      if (mode !== 'entrance' && !label) return;
      const node: TNode = { id: nextId(graph, 'V'), x: p.x, y: p.y, type: mode, vertical: label || undefined };
      const edges = runFrom ? [...graph.edges, edge(graph, runFrom, node.id, 'hallway')] : graph.edges;
      commit({ ...graph, nodes: [...graph.nodes, node], edges }, `${mode} placed`);
      setRunFrom(node.id);
      return;
    }

    // corridor mode
    if (hit) {
      if (runFrom && runFrom !== hit.id) {
        commit({ ...graph, edges: [...graph.edges, edge(graph, runFrom, hit.id, 'hallway')] }, 'Joined');
      }
      setRunFrom(hit.id);
      return;
    }

    // Nothing under the cursor -- but if we're on top of an existing corridor
    // LINE, join it rather than laying an unconnected point over it.
    //
    // Hitting an existing point exactly is hard, and missing it produces two
    // networks that overlap on screen while sharing nothing. That reads as a
    // finished map and routes fail everywhere. Snapping to the line makes the
    // common case -- "this hallway meets that one" -- work by clicking roughly
    // where they cross.
    const near = edgeAt(p, tol);
    if (near) {
      const { edge: hitEdge, point } = near;
      const junction: TNode = { id: nextId(graph, 'N'), x: point.x, y: point.y, type: 'junction' };
      const edges = graph.edges.filter((e) => e.id !== hitEdge.id);
      edges.push(
        { ...edge(graph, hitEdge.from, junction.id, hitEdge.kind), id: hitEdge.id + 'a' },
        { ...edge(graph, junction.id, hitEdge.to, hitEdge.kind), id: hitEdge.id + 'b' },
      );
      if (runFrom) edges.push(edge(graph, runFrom, junction.id, 'hallway'));
      commit({ ...graph, nodes: [...graph.nodes, junction], edges }, 'Joined to corridor');
      setRunFrom(junction.id);
      return;
    }

    const node: TNode = { id: nextId(graph, 'N'), x: p.x, y: p.y, type: 'corridor' };
    const edges = runFrom ? [...graph.edges, edge(graph, runFrom, node.id, 'hallway')] : graph.edges;
    commit({ ...graph, nodes: [...graph.nodes, node], edges });
    setRunFrom(node.id);
  };

  /** Closest drawn corridor line within `tolPx`, and where on it the click fell. */
  const edgeAt = (p: { x: number; y: number }, tolPx: number) => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    let best: { edge: TEdge; point: { x: number; y: number }; d: number } | null = null;
    for (const e of graph.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const proj = projectOntoSegment(p, a, b);
      // Ignore hits at the very ends -- those are the endpoints, already handled.
      if (proj.t < 0.05 || proj.t > 0.95) continue;
      if (proj.distance < tolPx && (!best || proj.distance < best.d)) {
        best = { edge: e, point: proj.point, d: proj.distance };
      }
    }
    return best;
  };

  // --- pan / zoom -----------------------------------------------------------
  const onWheel = (evt: React.WheelEvent) => {
    if (!raw) return;
    const p = toImage(evt);
    const factor = evt.deltaY > 0 ? 1.15 : 1 / 1.15;
    const w = Math.min(raw.image.width * 1.5, Math.max(300, view.w * factor));
    const h = w * (view.h / view.w);
    // Zoom about the cursor: keep the point under the pointer where it is.
    setView({ x: p.x - (p.x - view.x) * (w / view.w), y: p.y - (p.y - view.y) * (h / view.h), w, h });
  };

  const panning = mode === 'pan' || spaceHeld;

  const onMouseDown = (evt: React.MouseEvent) => {
    if (panning || evt.button === 1 || evt.button === 2 || evt.altKey) {
      evt.preventDefault();
      pan.current = { x: evt.clientX, y: evt.clientY, vx: view.x, vy: view.y };
      return;
    }
    // Select mode only. In corridor mode a drag starting on a node is ambiguous
    // -- move it, or start a line from it? -- so dragging lives behind V.
    if (mode !== 'select' || relinking) return;
    const p = toImage(evt);
    const hit = nodeAt(p, (view.w / 1000) * 12, true);
    if (!hit) return;
    evt.preventDefault();
    drag.current = { id: hit.id, isDoor: graph.doors.some((d) => d.id === hit.id), before: graph, moved: false };
    setSelected(hit.id);
  };

  /** Frame the whole floor plan. The way back when you've zoomed into nowhere. */
  const fitView = useCallback(() => {
    if (raw) setView({ x: 0, y: 0, w: raw.image.width, h: raw.image.height });
  }, [raw]);

  /** Zoom about the centre of the view, for the toolbar buttons. */
  const zoomBy = (factor: number) => {
    if (!raw) return;
    const w = Math.min(raw.image.width * 1.5, Math.max(300, view.w * factor));
    const h = w * (view.h / view.w);
    setView({
      x: view.x + (view.w - w) / 2,
      y: view.y + (view.h - h) / 2,
      w, h,
    });
  };
  const onMouseMove = (evt: React.MouseEvent) => {
    if (drag.current) { dragTo(toImage(evt)); return; }

    // Read everything we need NOW, into plain locals.
    //
    // The updater passed to setView runs whenever React chooses, which can be
    // after endPan has already nulled pan.current -- so reading the ref inside
    // the updater crashes on a drag that ends between the two. Same for the
    // event: capture the numbers, not the object.
    const start = pan.current;
    if (!start || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const dx = evt.clientX - start.x;
    const dy = evt.clientY - start.y;

    setView((v) => {
      // Same uniform scale the SVG uses, so the map tracks the cursor exactly.
      const scale = Math.min(r.width / v.w, r.height / v.h);
      return { ...v, x: start.vx - dx / scale, y: start.vy - dy / scale };
    });
  };

  /**
   * Live node drag.
   *
   * A door is pinned to the nearest corridor line rather than following the
   * cursor exactly: a small drag slides it along its hallway, a big one moves it
   * to another. Letting a door float off the corridor would leave a route ending
   * in mid-air. Drawn nodes follow the cursor freely.
   */
  const dragTo = (p: { x: number; y: number }) => {
    const d = drag.current;
    if (!d) return;
    d.moved = true;

    setGraph((g) => {
      if (d.isDoor) {
        const byId = new Map(g.nodes.map((n) => [n.id, n]));
        let best: { x: number; y: number; dist: number } | null = null;
        for (const e of g.edges) {
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b) continue;
          const proj = projectOntoSegment(p, a, b);
          if (!best || proj.distance < best.dist) best = { ...proj.point, dist: proj.distance };
        }
        if (!best) return g;
        const doors = g.doors.map((n) => (n.id === d.id ? { ...n, x: best!.x, y: best!.y } : n));
        return rebuildDoorChains({ ...g, doors });
      }
      const nodes = g.nodes.map((n) => (n.id === d.id ? { ...n, x: p.x, y: p.y } : n));
      return rebuildDoorChains({ ...g, nodes });
    });
  };

  const endPan = () => {
    const d = drag.current;
    if (d) {
      drag.current = null;
      // Push ONE history entry for the whole gesture, not one per mouse-move.
      if (d.moved) { setHistory((h) => [...h.slice(-49), d.before]); setStatus(`Moved ${d.id}`); }
    }
    setTimeout(() => { pan.current = null; }, 0);
  };

  // --- auto-link ------------------------------------------------------------
  /**
   * Connect the doors you placed to the corridors you drew.
   *
   * This no longer invents doors. It used to guess a door's position by
   * projecting the room's OCR label onto the nearest hallway, which put the door
   * at the centre of the room's text rather than where the door actually is. Now
   * you place the door where the plan shows it, and this only has to answer
   * "which corridor does it open onto, and where along it".
   *
   * A door does not move -- the corridor is split at the point closest to it, so
   * the door keeps the position you gave it and gains a connection.
   */
  const doAutoLink = () => {
    if (!raw) return;
    const hallways = graph.edges.filter((e) => e.kind === 'hallway');
    if (!hallways.length) { setStatus('Draw some corridors first'); return; }
    if (!graph.doors.length) { setStatus('Place some doors first — press D'); return; }

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const maxPx = 25 * raw.pixelsPerMetre;

    let connected = 0;
    const tooFar: string[] = [];
    for (const d of graph.doors) {
      let nearest = Infinity;
      for (const e of hallways) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        nearest = Math.min(nearest, projectOntoSegment(d, a, b).distance);
      }
      if (nearest <= maxPx) connected++;
      else tooFar.push(d.label ?? d.id);
    }

    // rebuildDoorChains does the actual threading: for every corridor, walk it
    // through the doors nearest to it, in order along the segment.
    commit(rebuildDoorChains(graph),
      `Connected ${connected} of ${graph.doors.length} doors` +
      (tooFar.length ? ` — ${tooFar.length} too far from any corridor` : ''));
  };

  /** Wipe one category. Corridors take the door connections with them. */
  const clearDoors = () => commit({ ...graph, doors: [], doorEdges: [] }, 'Cleared all doors');
  const clearCorridors = () =>
    commit({ ...graph, nodes: [], edges: [], doorEdges: [] }, 'Cleared all corridors');
  const resetAll = () => {
    if (!confirm('Clear every door and corridor on this floor? This cannot be undone except with ⌘Z.')) return;
    commit(EMPTY, 'Reset');
  };

  // --- connectivity ---------------------------------------------------------
  /**
   * Which island each node belongs to, biggest island first (id 0).
   *
   * This is the check that matters most and the one that is impossible to eyeball.
   * Two corridors drawn so they cross on screen are still two separate networks
   * unless they share a node -- the map looks finished and routing fails between
   * every pair of rooms that isn't on the same island.
   */
  const islands = useMemo(() => {
    const nodes = allNodes(graph);
    const adj = new Map(nodes.map((n) => [n.id, [] as string[]]));
    for (const e of allEdges(graph)) {
      adj.get(e.from)?.push(e.to);
      adj.get(e.to)?.push(e.from);
    }
    const of = new Map<string, number>();
    const groups: string[][] = [];
    for (const n of nodes) {
      if (of.has(n.id)) continue;
      const members: string[] = [];
      const stack = [n.id];
      while (stack.length) {
        const x = stack.pop()!;
        if (of.has(x)) continue;
        of.set(x, groups.length);
        members.push(x);
        for (const y of adj.get(x) ?? []) if (!of.has(y)) stack.push(y);
      }
      groups.push(members);
    }
    // Renumber so 0 is the largest -- that's the one everything should join.
    const order = groups.map((g, i) => i).sort((a, b) => groups[b].length - groups[a].length);
    const rank = new Map(order.map((old, nu) => [old, nu]));
    const ofRanked = new Map([...of].map(([id, g]) => [id, rank.get(g)!]));
    return { of: ofRanked, groups: order.map((i) => groups[i]) };
  }, [graph]);

  // --- problems -------------------------------------------------------------
  const problems = useMemo(() => {
    if (!raw) return [];
    const out: { kind: string; detail: string; room?: string; nodeId?: string }[] = [];

    if (islands.groups.length > 1) {
      const stranded = islands.groups.slice(1);
      const roomsOff = graph.doors.filter((d) => (islands.of.get(d.id) ?? 0) !== 0).length;
      out.push({
        kind: 'split',
        detail: `Corridors are in ${islands.groups.length} disconnected pieces — ${roomsOff} rooms unreachable from the main network`,
      });
      for (const g of stranded) {
        const anchor = g.find((id) => !id.startsWith('D')) ?? g[0];
        out.push({
          kind: 'split',
          detail: `Island of ${g.length}: join it near ${anchor}`,
          nodeId: anchor,
        });
      }
    }

    const served = roomDoors(graph);
    for (const r of raw.rooms) {
      if (!served[r.number]) {
        out.push({ kind: 'unlinked', detail: `${r.number} — no door placed`, room: r.number });
      }
    }
    // A door typed against a room OCR never found. Allowed on purpose -- OCR
    // missed rooms on both floors -- but worth surfacing in case it's a typo.
    const known = new Set(raw.rooms.map((r) => r.number));
    for (const d of graph.doors) {
      if (d.room && !known.has(d.room)) {
        out.push({ kind: 'unknown', detail: `${d.label} — "${d.room}" not in the OCR list`, nodeId: d.id });
      }
    }
    const used = new Set(allEdges(graph).flatMap((e) => [e.from, e.to]));
    for (const n of allNodes(graph)) {
      if (!used.has(n.id)) out.push({ kind: 'orphan', detail: `${n.id} connects to nothing`, nodeId: n.id });
    }
    for (const r of raw.rooms) {
      if (r.confidence < 0.9) out.push({ kind: 'ocr', detail: `${r.number} low OCR confidence`, room: r.number });
    }
    return out;
  }, [raw, graph, islands]);

  // --- save -----------------------------------------------------------------
  const save = async () => {
    if (!raw) return;
    const ppm = raw.pixelsPerMetre;
    const H = raw.image.height;
    const cosLat = Math.cos((raw.origin.lat * Math.PI) / 180);
    // Image y grows downward, world y grows north -- flip once, here.
    const toLL = (n: TNode) => ({
      lat: +(raw.origin.lat + ((H - n.y) / ppm) / M_PER_DEG_LAT).toFixed(8),
      lon: +(raw.origin.lon + (n.x / ppm) / (M_PER_DEG_LON * cosLat)).toFixed(8),
    });

    const nodes = allNodes(graph).map((n) => ({
      id: `W${raw.floor}-${n.id}`, ...toLL(n),
      floor: raw.floor, elevation: (raw.floor - 1) * 4.2,
      type: n.type, ...(n.vertical ? { vertical: n.vertical } : {}),
    }));
    const pos = new Map(allNodes(graph).map((n) => [n.id, n]));
    const edges = allEdges(graph).map((e) => {
      const a = pos.get(e.from)!, b = pos.get(e.to)!;
      return {
        id: `W${raw.floor}-${e.id}`, from: `W${raw.floor}-${e.from}`, to: `W${raw.floor}-${e.to}`,
        meters: +(Math.hypot(b.x - a.x, b.y - a.y) / ppm).toFixed(2), kind: e.kind,
      };
    });
    // A room can have several doors, so the app gets all of them and lets the
    // router pick whichever gives the shorter route.
    const served = roomDoors(graph);
    const known = new Map(raw.rooms.map((r) => [r.number, r]));
    const rooms = Object.entries(served).map(([number, doorIds]) => ({
      number,
      type: known.get(number)?.type ?? 'UNKNOWN',
      floor: raw.floor,
      doorNodeIds: doorIds.map((id) => `W${raw.floor}-${id}`),
    }));

    const res = await fetch('/api/tracer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ building, floor: raw.floor, trace: graph, nodes, edges, rooms }),
    });
    const d = await res.json();
    setStatus(d.ok ? `Saved ${nodes.length} nodes, ${edges.length} edges, ${rooms.length} rooms` : `Save failed: ${d.error}`);
  };

  // --- render ---------------------------------------------------------------
  if (error) return <div className="p-8 text-red-600 font-mono text-sm">{error}</div>;
  if (!raw) return <div className="p-8 text-neutral-500">Loading…</div>;

  const byId = new Map(allNodes(graph).map((n) => [n.id, n]));
  const drawnEdges = allEdges(graph);
  const drawnNodes = allNodes(graph);
  const served = roomDoors(graph);
  const r = view.w / 1000;

  return (
    <div className="flex h-screen flex-col bg-neutral-100">
      <Toolbar
        mode={mode} setMode={(m) => { setMode(m); setRunFrom(null); }}
        building={building} floor={raw.floor}
        onAutoLink={doAutoLink} onUndo={undo} onSave={save}
        canUndo={history.length > 0} status={status}
        onZoomIn={() => zoomBy(1 / 1.4)} onZoomOut={() => zoomBy(1.4)} onFit={fitView}
        zoomPct={Math.round((raw.image.width / view.w) * 100)}
        onClearDoors={clearDoors} onClearCorridors={clearCorridors} onReset={resetAll}
      />

      <div className="flex min-h-0 flex-1">
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className={`flex-1 bg-white ${panning
            ? (pan.current ? 'cursor-grabbing' : 'cursor-grab')
            : 'cursor-crosshair'}`}
          onClick={onClick} onWheel={onWheel}
          onDoubleClick={(evt) => {
            if (mode !== 'select') return;
            const hit = nodeAt(toImage(evt), (view.w / 1000) * 12, true);
            if (hit && graph.doors.some((d) => d.id === hit.id)) renameDoor(hit.id);
          }}
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={endPan} onMouseLeave={endPan}
          onContextMenu={(e) => e.preventDefault()}
        >
          <image href={raw.image.file} width={raw.image.width} height={raw.image.height} />

          {raw.rooms.map((room) => (
            <circle key={room.number} cx={room.px.x} cy={room.px.y} r={3.5 * r}
              className={served[room.number] ? 'fill-emerald-500/60' : 'fill-red-500/70'} />
          ))}

          {/* Anything not on the main island is drawn in red. Two corridors can
              cross on screen and still be separate networks, so colour is the
              only way to see it. */}
          {drawnEdges.map((e) => {
            const a = byId.get(e.from), b = byId.get(e.to);
            if (!a || !b) return null;
            const off = (islands.of.get(e.from) ?? 0) !== 0;
            return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              strokeWidth={2.5 * r} className={off ? 'stroke-red-500' : 'stroke-blue-600'} />;
          })}

          {drawnNodes.map((n) => {
            const room = n.label;
            const isRun = n.id === runFrom;
            const off = (islands.of.get(n.id) ?? 0) !== 0;
            const fill = n.type === 'door' ? 'fill-white'
              : n.type === 'stair' ? 'fill-amber-500'
              : n.type === 'elevator' ? 'fill-violet-500'
              : n.type === 'entrance' ? 'fill-emerald-600'
              : off ? 'fill-red-500' : 'fill-blue-600';
            return (
              <g key={n.id}>
                <circle cx={n.x} cy={n.y} r={(n.type === 'door' ? 3 : 5) * r}
                  className={`${fill} ${off ? 'stroke-red-700' : 'stroke-blue-700'}`}
                  strokeWidth={1.5 * r} />
                {isRun && <circle cx={n.x} cy={n.y} r={9 * r} className="fill-none stroke-blue-500"
                  strokeWidth={1.5 * r} strokeDasharray={`${3 * r} ${3 * r}`} />}
                {room && view.w < 2200 && (
                  <text x={n.x} y={n.y - 7 * r} textAnchor="middle"
                    fontSize={9 * r} className="fill-blue-900 font-medium">{room}</text>
                )}
              </g>
            );
          })}
        </svg>

        <SidePanel
          raw={raw} graph={graph} problems={problems} selected={selected}
          relinking={relinking} onRelink={setRelinking}
          onFocusRoom={(room) => {
            const rm = raw.rooms.find((x) => x.number === room);
            if (rm) setView({ x: rm.px.x - 500, y: rm.px.y - 325, w: 1000, h: 650 });
          }}
          onFocusNode={(id) => {
            const n = allNodes(graph).find((x) => x.id === id);
            if (n) setView({ x: n.x - 700, y: n.y - 455, w: 1400, h: 910 });
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Toolbar(p: {
  mode: Mode; setMode: (m: Mode) => void; building: string; floor: number;
  onAutoLink: () => void; onUndo: () => void; onSave: () => void;
  canUndo: boolean; status: string;
  onZoomIn: () => void; onZoomOut: () => void; onFit: () => void; zoomPct: number;
  onClearDoors: () => void; onClearCorridors: () => void; onReset: () => void;
}) {
  const modes: [Mode, string][] = [
    ['corridor', 'Corridor  C'], ['door', 'Door  D'], ['pan', 'Pan  H'], ['stair', 'Stair  S'],

    ['elevator', 'Lift  E'], ['entrance', 'Entrance  N'], ['select', 'Select  V'],
  ];
  return (
    <div className="flex items-center gap-2 border-b border-neutral-300 bg-white px-3 py-2">
      {modes.map(([m, label]) => (
        <button key={m} onClick={() => p.setMode(m)}
          className={`rounded px-3 py-1.5 text-sm ${p.mode === m
            ? 'bg-blue-600 text-white' : 'border border-neutral-300 text-neutral-700 hover:bg-neutral-100'}`}>
          {label}
        </button>
      ))}
      <div className="mx-2 h-5 w-px bg-neutral-300" />
      <button onClick={p.onZoomOut} title="Zoom out"
        className="rounded border border-neutral-300 px-2.5 py-1.5 text-sm hover:bg-neutral-100">−</button>
      <span className="w-12 text-center text-xs tabular-nums text-neutral-500">{p.zoomPct}%</span>
      <button onClick={p.onZoomIn} title="Zoom in"
        className="rounded border border-neutral-300 px-2.5 py-1.5 text-sm hover:bg-neutral-100">+</button>
      <button onClick={p.onFit} title="Fit the whole floor plan"
        className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100">Fit</button>
      <div className="mx-2 h-5 w-px bg-neutral-300" />
      <button onClick={p.onAutoLink}
        className="rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700">
        Auto-link doors
      </button>
      <button onClick={p.onUndo} disabled={!p.canUndo}
        className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40">
        Undo  ⌘Z
      </button>
      <button onClick={p.onSave}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700">
        Save
      </button>
      <div className="mx-2 h-5 w-px bg-neutral-300" />
      <button onClick={p.onClearDoors} title="Remove every door on this floor"
        className="rounded border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100">
        Clear doors
      </button>
      <button onClick={p.onClearCorridors} title="Remove every corridor on this floor"
        className="rounded border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100">
        Clear corridors
      </button>
      <button onClick={p.onReset} title="Remove everything on this floor"
        className="rounded border border-red-300 px-2.5 py-1.5 text-xs text-red-700 hover:bg-red-50">
        Reset
      </button>
      <span className="ml-3 text-sm text-neutral-500">{p.building} · level {p.floor}</span>
      <span className="ml-auto text-sm text-emerald-700">{p.status}</span>
    </div>
  );
}

function SidePanel(p: {
  raw: Raw; graph: Graph;
  problems: { kind: string; detail: string; room?: string; nodeId?: string }[];
  selected: string | null; relinking: string | null;
  onRelink: (room: string | null) => void; onFocusRoom: (room: string) => void;
  onFocusNode: (id: string) => void;
}) {
  const linked = new Set(p.graph.doors.map((d) => d.room).filter(Boolean)).size;
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-neutral-300 bg-white p-3 text-sm">
      <div className="mb-3 grid grid-cols-2 gap-2">
        {[['nodes', p.graph.nodes.length + p.graph.doors.length], ['edges', (p.graph.doorEdges.length || p.graph.edges.length)],
          ['rooms', p.raw.rooms.length], ['linked', linked]].map(([k, v]) => (
          <div key={k as string} className="rounded bg-neutral-100 px-2 py-1.5">
            <div className="text-xs text-neutral-500">{k}</div>
            <div className="text-lg font-medium tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      {p.relinking && (
        <div className="mb-3 rounded border border-blue-300 bg-blue-50 p-2 text-blue-900">
          Re-linking <b>{p.relinking}</b> — click the node its door should attach to.
          <button onClick={() => p.onRelink(null)} className="ml-2 underline">cancel</button>
        </div>
      )}

      <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
        Problems ({p.problems.length})
      </h2>
      {p.problems.length === 0 && <p className="text-emerald-700">None — map is sound.</p>}
      <ul className="space-y-1">
        {p.problems.slice(0, 60).map((pr, i) => (
          <li key={i} className="flex items-center gap-2 rounded bg-red-50 px-2 py-1 text-red-800">
            <span className="flex-1">{pr.detail}</span>
            {pr.room && (
              <>
                <button onClick={() => p.onFocusRoom(pr.room!)} className="underline">find</button>
                <button onClick={() => p.onRelink(pr.room!)} className="underline">link</button>
              </>
            )}
            {pr.nodeId && (
              <button onClick={() => p.onFocusNode(pr.nodeId!)} className="underline">find</button>
            )}
          </li>
        ))}
      </ul>
      {p.problems.length > 60 && (
        <p className="mt-1 text-xs text-neutral-500">…and {p.problems.length - 60} more</p>
      )}

      <h2 className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-neutral-500">Controls</h2>
      <ul className="space-y-0.5 text-xs text-neutral-600">
        <li>click — place a corridor point</li>
        <li>click an existing point — join to it</li>
        <li>click on a corridor line — join to it</li>
        <li>Esc — end the current run</li>
        <li className="pt-1"><b>V — select mode</b></li>
        <li>&nbsp;&nbsp;drag a node — move it</li>
        <li>&nbsp;&nbsp;drag a door — slide it along the corridor</li>
        <li>&nbsp;&nbsp;double-click a door — retype its room</li>
        <li>&nbsp;&nbsp;Backspace — delete the selected node</li>
        <li className="pt-1"><b>hold Space + drag — pan</b> (any mode)</li>
        <li><b>H</b> — pan mode, then plain drag</li>
        <li>scroll — zoom · <b>Fit</b> — see the whole plan again</li>
        <li>⌘Z — undo</li>
      </ul>
    </aside>
  );
}

// ---------------------------------------------------------------------------

const nextId = (g: Graph, prefix: string) => {
  const n = g.nodes.filter((x) => x.id.startsWith(prefix)).length + 1;
  return `${prefix}${String(n).padStart(3, '0')}`;
};

const edge = (g: Graph, from: string, to: string, kind: TEdge['kind']): TEdge =>
  ({ id: `E${String(g.edges.length + 1).padStart(3, '0')}`, from, to, kind });
