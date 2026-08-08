// Turning a route into sentences.
//
// The whole thing falls out of comparing the bearing of each corridor with the
// bearing of the next one. If the direction barely changes you're continuing; if
// it swings left you turn left. No extra data needs to be authored for this.

import { angleDiff } from './geo';
import type { BuildingGraph, RouteResult } from './graph';

export type Step = {
  /** "Continue 24 m", "Turn left", "Take the stairs up to level 2" */
  text: string;
  meters: number;
  floor: number;
  /** Index into route.nodeIds where this step begins -- lets the map highlight it. */
  atNode: number;
};

/** Degrees of swing before we stop calling it "straight on". */
const SLIGHT = 20;
/** Beyond this it's a proper turn rather than a bear. */
const SHARP = 55;

function turnPhrase(delta: number): string {
  const side = delta > 0 ? 'right' : 'left';
  const size = Math.abs(delta);
  if (size < SLIGHT) return 'Continue straight';
  if (size < SHARP) return `Bear ${side}`;
  if (size < 150) return `Turn ${side}`;
  return 'Turn around';
}

/**
 * Build the instruction list.
 *
 * Consecutive hallway edges pointing the same way are merged, so a long corridor
 * traced as eight separate segments reads as one "continue 60 m" rather than
 * eight useless instructions.
 */
export function describeRoute(graph: BuildingGraph, route: RouteResult): Step[] {
  const steps: Step[] = [];
  if (route.edges.length === 0) return steps;

  let runMeters = 0;
  let runStartIdx = 0;
  let previousBearing: number | null = null;

  const flushRun = (floor: number) => {
    if (runMeters <= 0) return;
    steps.push({
      text: `Continue ${Math.round(runMeters)} m`,
      meters: runMeters,
      floor,
      atNode: runStartIdx,
    });
    runMeters = 0;
  };

  for (let i = 0; i < route.edges.length; i++) {
    const edge = route.edges[i];
    const fromId = route.nodeIds[i];
    const toId = route.nodeIds[i + 1];
    const fromNode = graph.nodes.get(fromId)!;
    const toNode = graph.nodes.get(toId)!;

    if (edge.kind === 'stair' || edge.kind === 'elevator') {
      flushRun(fromNode.floor);
      const up = toNode.floor > fromNode.floor;
      const how = edge.kind === 'stair' ? 'the stairs' : 'the lift';
      const label = fromNode.vertical ? ` (${fromNode.vertical})` : '';
      steps.push({
        text: `Take ${how}${label} ${up ? 'up' : 'down'} to level ${toNode.floor}`,
        meters: 0,
        floor: toNode.floor,
        atNode: i,
      });
      previousBearing = null; // heading is meaningless across a floor change
      runStartIdx = i + 1;
      continue;
    }

    const heading = graph.edgeBearing(edge, fromId);

    if (previousBearing !== null) {
      const delta = angleDiff(heading, previousBearing);
      if (Math.abs(delta) >= SLIGHT) {
        flushRun(fromNode.floor);
        steps.push({ text: turnPhrase(delta), meters: 0, floor: fromNode.floor, atNode: i });
        runStartIdx = i;
      }
    }

    runMeters += edge.meters;
    previousBearing = heading;
  }

  flushRun(graph.nodes.get(route.nodeIds[route.nodeIds.length - 1])!.floor);
  return steps;
}

/** One-line summary for the top of the panel. */
export function summarize(route: RouteResult): string {
  const mins = Math.max(1, Math.round(route.meters / 75)); // ~1.25 m/s walking
  return `${Math.round(route.meters)} m · about ${mins} min`;
}
