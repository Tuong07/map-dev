// Attaching rooms to the corridor network without clicking 210 doors.
//
// OCR knows where every room label is. Corridors get drawn by hand. The join
// between them can be computed: a room almost always opens onto the corridor
// nearest it, so we drop a perpendicular from the label to the closest edge and
// put the door there.
//
// It is a heuristic and it will be wrong sometimes -- corner rooms, rooms that
// open into other rooms, a room whose nearest corridor is on the far side of a
// wall. That is why the tracer surfaces every link for review and lets you
// re-point the bad ones. Being approximately right for 200 rooms and letting a
// human fix ten beats clicking all 210.

import type { Point } from './geo';

export type Segment = { id: string; a: Point; b: Point };

export type Projection = {
  /** Closest point on the segment. */
  point: Point;
  /** 0..1 along the segment, so the tracer can split it at the right place. */
  t: number;
  distance: number;
};

/**
 * Closest point on a line segment to `p`.
 *
 * Project p onto the infinite line, then clamp to the segment. Without the clamp
 * a room beside a short corridor would attach to empty space beyond its end.
 */
export function projectOntoSegment(p: Point, a: Point, b: Point): Projection {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { point: a, t: 0, distance: Math.hypot(p.x - a.x, p.y - a.y) };

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point, t, distance: Math.hypot(p.x - point.x, p.y - point.y) };
}

export type LinkResult = {
  roomNumber: string;
  segmentId: string;
  /** Where the door sits on the corridor. */
  point: Point;
  t: number;
  /** Metres from the room label to the corridor. Large values are suspicious. */
  distance: number;
};

/**
 * Link every room to its nearest corridor segment.
 *
 * `maxDistance` guards against nonsense: a room 40 m from any corridor is not
 * "far down the hall", it means the corridor serving it hasn't been drawn yet.
 * Those come back as unlinked so the tracer can flag them rather than inventing
 * a door through three walls.
 */
export function autoLinkRooms(
  rooms: { number: string; point: Point }[],
  segments: Segment[],
  maxDistance = 25,
): { links: LinkResult[]; unlinked: string[] } {
  const links: LinkResult[] = [];
  const unlinked: string[] = [];

  for (const room of rooms) {
    let best: LinkResult | null = null;
    for (const seg of segments) {
      const proj = projectOntoSegment(room.point, seg.a, seg.b);
      if (!best || proj.distance < best.distance) {
        best = {
          roomNumber: room.number,
          segmentId: seg.id,
          point: proj.point,
          t: proj.t,
          distance: proj.distance,
        };
      }
    }
    if (best && best.distance <= maxDistance) links.push(best);
    else unlinked.push(room.number);
  }

  return { links, unlinked };
}
