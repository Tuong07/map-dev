// Converting between the three coordinate frames. See docs/ARCHITECTURE.md.
//
//   lat/lon on disk   ->   metres in logic   ->   pixels only when drawing
//
// Storing lat/lon means the data stays true regardless of how we happen to draw
// it, and AR later needs real-world coordinates. But doing maths in degrees is
// miserable -- a degree of longitude is a different distance at every latitude --
// so everything computed works in metres from a fixed origin.

/** Metres per degree of latitude. Near enough constant everywhere. */
const M_PER_DEG_LAT = 110540;
/** Metres per degree of longitude AT THE EQUATOR; shrinks with cos(latitude). */
const M_PER_DEG_LON = 111320;

export type LatLon = { lat: number; lon: number };
export type Point = { x: number; y: number };

/**
 * Flat-earth projection, origin at the building.
 *
 * Over a few hundred metres the curvature error is sub-millimetre, so a real
 * projection library would add a dependency and change nothing. +x is east,
 * +y is north.
 */
export function toMeters(p: LatLon, origin: LatLon): Point {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    x: (p.lon - origin.lon) * M_PER_DEG_LON * cosLat,
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** Inverse of toMeters. The tracer uses this to turn clicks into storable data. */
export function toLatLon(p: Point, origin: LatLon): LatLon {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: origin.lat + p.y / M_PER_DEG_LAT,
    lon: origin.lon + p.x / (M_PER_DEG_LON * cosLat),
  };
}

export const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** Great-circle-free distance in metres between two lat/lons near each other. */
export function distanceLatLon(a: LatLon, b: LatLon): number {
  return distance(toMeters(a, a), toMeters(b, a));
}

/**
 * Bearing in degrees clockwise from north.
 *
 * Note the argument order: atan2(east, north), not the usual atan2(y, x). Compass
 * bearings run clockwise from north, whereas maths angles run anticlockwise from
 * east, and swapping the arguments converts between the two.
 */
export function bearing(from: Point, to: Point): number {
  const deg = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Smallest signed angle from `b` to `a`, in [-180, 180]. Negative is left. */
export function angleDiff(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}
