'use client';

// The map editor. Desktop only, development only -- see docs/ARCHITECTURE.md.
//
// Works entirely in IMAGE PIXELS while you draw, and converts to metres and
// lat/lon once, on save. Clicking is a pixel operation; converting on every
// click would just accumulate rounding error for no benefit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { autoLinkRooms, projectOntoSegment, type Segment } from '@/lib/core/autolink';

type Mode = 'corridor' | 'stair' | 'elevator' | 'entrance' | 'select' | 'pan';

type TNode = {
  id: string;
  x: number;            // image pixels
  y: number;
  type: 'corridor' | 'junction' | 'door' | 'stair' | 'elevator' | 'entrance';
  vertical?: string;    // "STAIR 4" -- shared label links floors
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
  doors: TNode[];
  doorEdges: TEdge[];
  roomDoor: Record<string, string>;
};

type RawRoom = { number: string; type: string; px: { x: number; y: number }; confidence: number };
type Raw = {
  building: string; floor: number; origin: { lat: number; lon: number };
  image: { file: string; width: number; height: number };
  pixelsPerMetre: number; rooms: RawRoom[];
};

const EMPTY: Graph = { nodes: [], edges: [], doors: [], doorEdges: [], roomDoor: {} };

/** Everything drawn plus everything derived, for rendering and saving. */
const allNodes = (g: Graph) => [...g.nodes, ...g.doors];
/** Once doors exist they carry the split hallway chain, replacing the raw edges. */
const allEdges = (g: Graph) => (g.doorEdges.length ? g.doorEdges : g.edges);

/**
 * Older traces stored doors inside `nodes` and split the hallway edges in place.
 * Recover the skeleton: keep the drawn nodes, and reconnect any two of them that
 * were joined through a chain of door nodes.
 */
function migrate(t: any): Graph {
  if (!t) return EMPTY;
  if (Array.isArray(t.doors)) return { ...EMPTY, ...t };

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
  return { nodes: drawn, edges, doors: [], doorEdges: [], roomDoor: {} };
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

  // --- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
      if (e.key === 'Escape') { setRunFrom(null); setSelected(null); setRelinking(null); return; }
      if (e.target instanceof HTMLInputElement) return;
      // Hold space to pan without leaving the drawing mode -- the convention in
      // every design tool, and it means you never lose your place mid-corridor.
      if (e.code === 'Space') { e.preventDefault(); setSpaceHeld(true); return; }
      const keys: Record<string, Mode> = {
        c: 'corridor', s: 'stair', e: 'elevator', n: 'entrance', v: 'select', h: 'pan',
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
  }, [undo]);

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

  // --- drawing --------------------------------------------------------------
  const onClick = (evt: React.MouseEvent) => {
    if (!raw || pan.current) return;
    const p = toImage(evt);
    const tol = (view.w / 1000) * 12;
    const hit = nodeAt(p, tol, !!relinking);

    if (relinking) {
      // Second click of a re-link: attach the chosen room to this node.
      if (!hit) { setStatus('Click an existing node to attach the room to'); return; }
      commit({ ...graph, roomDoor: { ...graph.roomDoor, [relinking]: hit.id } }, `${relinking} re-linked`);
      setRelinking(null);
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
    const node: TNode = { id: nextId(graph, 'N'), x: p.x, y: p.y, type: 'corridor' };
    const edges = runFrom ? [...graph.edges, edge(graph, runFrom, node.id, 'hallway')] : graph.edges;
    commit({ ...graph, nodes: [...graph.nodes, node], edges });
    setRunFrom(node.id);
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
    }
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
  const endPan = () => { setTimeout(() => { pan.current = null; }, 0); };

  // --- auto-link ------------------------------------------------------------
  const doAutoLink = () => {
    if (!raw) return;
    const hallways = graph.edges.filter((e) => e.kind === 'hallway');
    if (!hallways.length) { setStatus('Draw some corridors first'); return; }

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const segments: Segment[] = hallways.map((e) => ({
      id: e.id,
      a: byId.get(e.from)!,
      b: byId.get(e.to)!,
    }));

    const maxPx = 25 * raw.pixelsPerMetre;
    const { links, unlinked } = autoLinkRooms(
      raw.rooms.map((r) => ({ number: r.number, point: r.px })),
      segments,
      maxPx,
    );

    // Each door becomes a real node ON the corridor, which means splitting the
    // segment it landed on. Sorting by t keeps the rebuilt chain in order.
    // These arrays start EMPTY every run -- that is what makes re-running safe.
    const doors: TNode[] = [];
    const doorEdges: TEdge[] = [];
    const roomDoor: Record<string, string> = {};
    const bySeg = new Map<string, typeof links>();
    for (const l of links) {
      if (!bySeg.has(l.segmentId)) bySeg.set(l.segmentId, []);
      bySeg.get(l.segmentId)!.push(l);
    }

    let seq = 0;
    for (const seg of hallways) {
      const on = (bySeg.get(seg.id) ?? []).sort((a, b) => a.t - b.t);
      let prev = seg.from;
      for (const l of on) {
        const id = `D${String(++seq).padStart(3, '0')}`;
        doors.push({ id, x: l.point.x, y: l.point.y, type: 'door' });
        doorEdges.push({ id: `E${id}a`, from: prev, to: id, kind: 'hallway' });
        roomDoor[l.roomNumber] = id;
        prev = id;
      }
      doorEdges.push({ id: `E${seg.id}z`, from: prev, to: seg.to, kind: 'hallway' });
    }

    commit({ ...graph, doors, doorEdges, roomDoor },
      `Linked ${links.length} rooms${unlinked.length ? `, ${unlinked.length} too far` : ''}`);
  };

  // --- problems -------------------------------------------------------------
  const problems = useMemo(() => {
    if (!raw) return [];
    const out: { kind: string; detail: string; room?: string }[] = [];
    const linked = new Set(Object.keys(graph.roomDoor));
    for (const r of raw.rooms) {
      if (!linked.has(r.number)) out.push({ kind: 'unlinked', detail: `${r.number} has no door`, room: r.number });
    }
    const used = new Set(allEdges(graph).flatMap((e) => [e.from, e.to]));
    for (const n of allNodes(graph)) {
      if (!used.has(n.id)) out.push({ kind: 'orphan', detail: `${n.id} connects to nothing` });
    }
    for (const r of raw.rooms) {
      if (r.confidence < 0.9) out.push({ kind: 'ocr', detail: `${r.number} low OCR confidence`, room: r.number });
    }
    return out;
  }, [raw, graph]);

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
    const rooms = raw.rooms.filter((r) => graph.roomDoor[r.number]).map((r) => ({
      number: r.number, type: r.type, floor: raw.floor,
      doorNodeId: `W${raw.floor}-${graph.roomDoor[r.number]}`,
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
  const doorOf = new Map(Object.entries(graph.roomDoor).map(([room, node]) => [node, room]));
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
      />

      <div className="flex min-h-0 flex-1">
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className={`flex-1 bg-white ${panning
            ? (pan.current ? 'cursor-grabbing' : 'cursor-grab')
            : 'cursor-crosshair'}`}
          onClick={onClick} onWheel={onWheel}
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={endPan} onMouseLeave={endPan}
          onContextMenu={(e) => e.preventDefault()}
        >
          <image href={raw.image.file} width={raw.image.width} height={raw.image.height} />

          {raw.rooms.map((room) => (
            <circle key={room.number} cx={room.px.x} cy={room.px.y} r={3.5 * r}
              className={graph.roomDoor[room.number] ? 'fill-emerald-500/60' : 'fill-red-500/70'} />
          ))}

          {drawnEdges.map((e) => {
            const a = byId.get(e.from), b = byId.get(e.to);
            if (!a || !b) return null;
            return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              strokeWidth={2.5 * r} className="stroke-blue-600" />;
          })}

          {drawnNodes.map((n) => {
            const room = doorOf.get(n.id);
            const isRun = n.id === runFrom;
            const fill = n.type === 'door' ? 'fill-white'
              : n.type === 'stair' ? 'fill-amber-500'
              : n.type === 'elevator' ? 'fill-violet-500'
              : n.type === 'entrance' ? 'fill-emerald-600' : 'fill-blue-600';
            return (
              <g key={n.id}>
                <circle cx={n.x} cy={n.y} r={(n.type === 'door' ? 3 : 5) * r}
                  className={`${fill} stroke-blue-700`} strokeWidth={1.5 * r} />
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
}) {
  const modes: [Mode, string][] = [
    ['corridor', 'Corridor  C'], ['pan', 'Pan  H'], ['stair', 'Stair  S'],
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
      <span className="ml-3 text-sm text-neutral-500">{p.building} · level {p.floor}</span>
      <span className="ml-auto text-sm text-emerald-700">{p.status}</span>
    </div>
  );
}

function SidePanel(p: {
  raw: Raw; graph: Graph; problems: { kind: string; detail: string; room?: string }[];
  selected: string | null; relinking: string | null;
  onRelink: (room: string | null) => void; onFocusRoom: (room: string) => void;
}) {
  const linked = Object.keys(p.graph.roomDoor).length;
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
        <li>Esc — end the current run</li>
        <li><b>hold Space + drag — pan</b> (works in any mode)</li>
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
