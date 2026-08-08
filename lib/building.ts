// Loads map data and hands back a ready-to-use graph.
//
// The JSON is imported rather than fetched, so it's bundled at build time: no
// loading state, no network round-trip, no chance of the map being missing. At a
// few hundred KB that's the right trade -- see docs/ARCHITECTURE.md.

import meta from '@/data/test-building/meta.json';
import nodes from '@/data/test-building/nodes.json';
import edges from '@/data/test-building/edges.json';
import rooms from '@/data/test-building/rooms.json';
import anchors from '@/data/test-building/anchors.json';

import { BuildingGraph } from './core/graph';
import type { BuildingData } from './core/types';

export const buildingData = {
  ...meta,
  nodes,
  edges,
  rooms,
  anchors,
} as BuildingData;

/** One shared graph. Building it is cheap, but there's no reason to repeat it. */
export const building = new BuildingGraph(buildingData);

/** Entrances, in the order they should appear in the "start from" picker. */
export const entrances = buildingData.nodes.filter((n) => n.type === 'entrance');
