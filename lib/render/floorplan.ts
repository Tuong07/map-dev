// Turning metres into something SVG can draw.
//
// The trick here is that we DON'T convert to pixels ourselves. We set the SVG
// viewBox to the building's own extent in metres, so every coordinate can be
// plotted as-is and the browser handles the scaling. One less transform to get
// wrong, and the numbers stay readable in devtools.
//
// The one wrinkle: SVG's y axis grows downward, ours grows north. A single
// scale(1,-1) on the wrapping group fixes that, which is why plot() negates y.

import type { BuildingGraph } from '../core/graph';
import type { Point } from '../core/geo';

export type ViewBox = { minX: number; minY: number; width: number; height: number };

/** Metres of empty space kept around the building so labels aren't clipped. */
const PADDING_M = 8;

export function floorViewBox(graph: BuildingGraph, floor: number): ViewBox {
  const points = graph.data.nodes
    .filter((n) => n.floor === floor)
    .map((n) => graph.point(n.id));

  if (points.length === 0) return { minX: 0, minY: 0, width: 1, height: 1 };

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - PADDING_M;
  const maxX = Math.max(...xs) + PADDING_M;
  const minY = Math.min(...ys) - PADDING_M;
  const maxY = Math.max(...ys) + PADDING_M;

  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The viewBox string, in SVG space.
 *
 * plot() negates y, so a building spanning y = minY..maxY in metres occupies
 * -maxY..-minY on screen. That's what this expresses.
 */
export function viewBoxAttr(v: ViewBox): string {
  return `${v.minX} ${-(v.minY + v.height)} ${v.width} ${v.height}`;
}

/**
 * Metre-space point -> SVG point.
 *
 * Negating y is the ONLY flip. It's tempting to instead wrap everything in a
 * <g transform="scale(1,-1)">, but doing both cancels out and the building comes
 * out upside down -- and a group flip also mirrors every text label, which then
 * needs its own counter-transform. One negation here keeps text upright for free.
 */
export const plot = (p: Point) => ({ x: p.x, y: -p.y });

/**
 * Stroke widths and font sizes are in metres too, so they must be scaled to stay
 * legible whatever the building's size. A 60 m building and a 300 m one should
 * both come out looking sensible.
 */
export function scaleFor(v: ViewBox) {
  const span = Math.max(v.width, v.height);
  return {
    corridor: span / 180,
    route: span / 70,
    node: span / 220,
    marker: span / 45,
    font: span / 45,
  };
}
