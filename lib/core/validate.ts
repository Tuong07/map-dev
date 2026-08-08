// Integrity checks on map data.
//
// Every rule here exists because it's a mistake tracing actually produces, and
// each one is invisible when you look at the map. A room whose door isn't joined
// to anything looks perfectly fine on screen and simply never appears in a route.
// Better to fail loudly at build time than debug it three days later.

import { BuildingGraph } from './graph';
import { distance } from './geo';
import type { BuildingData } from './types';

export type Problem = { severity: 'error' | 'warning'; message: string };

/** Longest believable single corridor segment. Beyond this it's a mis-click. */
const MAX_EDGE_M = 100;
/** Shorter than this and two nodes were almost certainly meant to be one. */
const MIN_EDGE_M = 0.4;

export function validateBuilding(data: BuildingData): Problem[] {
  const problems: Problem[] = [];
  const error = (message: string) => problems.push({ severity: 'error', message });
  const warn = (message: string) => problems.push({ severity: 'warning', message });

  const graph = new BuildingGraph(data);

  // --- ids and references -------------------------------------------------
  const seenNode = new Set<string>();
  for (const n of data.nodes) {
    if (seenNode.has(n.id)) error(`duplicate node id: ${n.id}`);
    seenNode.add(n.id);
    if (!data.floors.includes(n.floor)) error(`node ${n.id} is on unlisted floor ${n.floor}`);
  }

  for (const e of data.edges) {
    if (!seenNode.has(e.from)) error(`edge ${e.id} starts at missing node ${e.from}`);
    if (!seenNode.has(e.to)) error(`edge ${e.id} ends at missing node ${e.to}`);
    if (e.from === e.to) error(`edge ${e.id} joins ${e.from} to itself`);
  }

  const seenRoom = new Set<string>();
  for (const r of data.rooms) {
    if (seenRoom.has(r.number)) error(`duplicate room number: ${r.number}`);
    seenRoom.add(r.number);
    if (!seenNode.has(r.doorNodeId)) error(`room ${r.number} has missing door node ${r.doorNodeId}`);
  }

  for (const a of data.anchors) {
    if (!seenNode.has(a.nodeId)) error(`anchor ${a.id} points at missing node ${a.nodeId}`);
    if (a.facingBearing < 0 || a.facingBearing >= 360) {
      error(`anchor ${a.id} has bearing ${a.facingBearing}, expected 0-359`);
    }
  }

  // --- geometry -----------------------------------------------------------
  for (const e of data.edges) {
    if (e.kind === 'stair' || e.kind === 'elevator') continue; // vertical, length is a floor height
    const a = graph.points.get(e.from);
    const b = graph.points.get(e.to);
    if (!a || !b) continue;

    const actual = distance(a, b);
    if (actual > MAX_EDGE_M) error(`edge ${e.id} is ${actual.toFixed(0)} m -- probably a mis-click`);
    else if (actual < MIN_EDGE_M) warn(`edge ${e.id} is ${actual.toFixed(2)} m -- duplicate node?`);

    // meters is derived, so a mismatch means someone hand-edited the JSON.
    if (Math.abs(actual - e.meters) > 0.5) {
      error(`edge ${e.id} stores ${e.meters} m but its coordinates say ${actual.toFixed(2)} m`);
    }
  }

  // --- connectivity -------------------------------------------------------
  for (const n of data.nodes) {
    if ((graph.adjacency.get(n.id) ?? []).length === 0) error(`node ${n.id} connects to nothing`);
  }

  // Every room must be reachable from every entrance. This is the check that
  // catches a corridor traced but never joined to the rest of the network.
  const entrances = data.nodes.filter((n) => n.type === 'entrance');
  if (entrances.length === 0) error('no entrance nodes -- routes have nowhere to start');

  for (const entrance of entrances) {
    for (const room of data.rooms) {
      if (!graph.route(entrance.id, room.doorNodeId)) {
        error(`room ${room.number} is unreachable from entrance ${entrance.id}`);
      }
    }
  }

  // --- vertical links -----------------------------------------------------
  const byLabel = new Map<string, Set<number>>();
  for (const n of data.nodes) {
    if (!n.vertical) continue;
    if (!byLabel.has(n.vertical)) byLabel.set(n.vertical, new Set());
    byLabel.get(n.vertical)!.add(n.floor);
  }
  for (const [label, floors] of byLabel) {
    if (floors.size < 2 && data.floors.length > 1) {
      warn(`"${label}" appears on only one floor -- nothing links through it`);
    }
  }

  // Step-free routing is only real if every room can be reached without stairs.
  if (data.nodes.some((n) => n.type === 'elevator')) {
    for (const room of data.rooms) {
      const reachable = entrances.some((e) =>
        graph.route(e.id, room.doorNodeId, { avoidStairs: true }),
      );
      if (!reachable) warn(`room ${room.number} has no step-free route`);
    }
  }

  return problems;
}
