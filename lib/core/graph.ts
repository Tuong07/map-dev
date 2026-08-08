// The corridor graph and the router that walks it.
//
// A* is hand-written rather than imported. It's about sixty lines, and being able
// to explain how the route is found is worth more here than saving them.

import type { BuildingData, Edge, Node } from './types';
import { bearing, distance, toMeters, type Point } from './geo';

/** Cost multipliers. Stairs and lifts are slower per metre than walking. */
const KIND_COST: Record<Edge['kind'], number> = {
  hallway: 1,
  door: 1,
  // A flight of stairs takes far longer than the same distance of corridor, and
  // this also stops the router sending someone up and straight back down.
  stair: 4,
  // Lifts cost more again -- you wait for them -- so a walker gets the stairs
  // unless they've asked to avoid them.
  elevator: 6,
};

export type RouteOptions = {
  /** Step-free routing: refuse stairs entirely and take lifts instead. */
  avoidStairs?: boolean;
};

export class BuildingGraph {
  readonly data: BuildingData;
  readonly nodes: Map<string, Node>;
  /** node id -> edges touching it. Built once; the router hits this constantly. */
  readonly adjacency: Map<string, Edge[]>;
  /** node id -> position in metres, precomputed so routing never re-projects. */
  readonly points: Map<string, Point>;

  constructor(data: BuildingData) {
    this.data = data;
    this.nodes = new Map(data.nodes.map((n) => [n.id, n]));
    this.points = new Map(
      data.nodes.map((n) => [n.id, toMeters({ lat: n.lat, lon: n.lon }, data.origin)]),
    );

    this.adjacency = new Map(data.nodes.map((n) => [n.id, [] as Edge[]]));
    for (const e of data.edges) {
      this.adjacency.get(e.from)?.push(e);
      this.adjacency.get(e.to)?.push(e);
    }
  }

  point(id: string): Point {
    const p = this.points.get(id);
    if (!p) throw new Error(`Unknown node: ${id}`);
    return p;
  }

  /** The node at the other end of an edge from `id`. Edges are undirected. */
  other(e: Edge, id: string): string {
    return e.from === id ? e.to : e.from;
  }

  edgeBearing(e: Edge, fromId: string): number {
    return bearing(this.point(fromId), this.point(this.other(e, fromId)));
  }

  roomByNumber(number: string): (typeof this.data.rooms)[number] | undefined {
    const want = normalizeRoomNumber(number);
    return this.data.rooms.find((r) => normalizeRoomNumber(r.number) === want);
  }

  /**
   * A* shortest path.
   *
   * A* is Dijkstra plus a hint: at each step prefer the node that looks closest
   * to the goal. The hint is straight-line distance, which can never overstate
   * the real walking distance -- and that guarantee is exactly what keeps the
   * result optimal rather than merely fast.
   */
  route(startId: string, goalId: string, opts: RouteOptions = {}): RouteResult | null {
    if (!this.nodes.has(startId) || !this.nodes.has(goalId)) return null;

    const goal = this.point(goalId);
    const heuristic = (id: string) => distance(this.point(id), goal);

    const cameFrom = new Map<string, { node: string; edge: Edge }>();
    const costSoFar = new Map<string, number>([[startId, 0]]);
    // A plain array scanned for the minimum. A binary heap would be faster, but
    // a floor has a few hundred nodes -- this is imperceptible and readable.
    const open: { id: string; priority: number }[] = [{ id: startId, priority: heuristic(startId) }];
    const settled = new Set<string>();

    while (open.length) {
      let bestAt = 0;
      for (let i = 1; i < open.length; i++) if (open[i].priority < open[bestAt].priority) bestAt = i;
      const current = open.splice(bestAt, 1)[0].id;

      if (current === goalId) return this.reconstruct(startId, goalId, cameFrom);
      if (settled.has(current)) continue;
      settled.add(current);

      for (const edge of this.adjacency.get(current) ?? []) {
        if (opts.avoidStairs && edge.kind === 'stair') continue;

        const next = this.other(edge, current);
        const cost = (costSoFar.get(current) ?? 0) + edge.meters * KIND_COST[edge.kind];
        if (cost < (costSoFar.get(next) ?? Infinity)) {
          costSoFar.set(next, cost);
          cameFrom.set(next, { node: current, edge });
          open.push({ id: next, priority: cost + heuristic(next) });
        }
      }
    }
    return null; // no walkable path -- usually a tracing mistake, see validate.ts
  }

  private reconstruct(
    startId: string,
    goalId: string,
    cameFrom: Map<string, { node: string; edge: Edge }>,
  ): RouteResult {
    const nodeIds = [goalId];
    const edges: Edge[] = [];
    let at = goalId;
    while (at !== startId) {
      const step = cameFrom.get(at);
      if (!step) break;
      edges.unshift(step.edge);
      at = step.node;
      nodeIds.unshift(at);
    }
    return {
      nodeIds,
      edges,
      meters: edges.reduce((sum, e) => sum + e.meters, 0),
      floors: [...new Set(nodeIds.map((id) => this.nodes.get(id)!.floor))],
    };
  }
}

export type RouteResult = {
  nodeIds: string[];
  edges: Edge[];
  /** True walking distance, unweighted -- what we show the user. */
  meters: number;
  floors: number[];
};

/**
 * Room numbers are compared loosely so people can type what they remember.
 * "1-004", "1 004", "w1004" and "1004" all match the same room.
 */
export function normalizeRoomNumber(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}
