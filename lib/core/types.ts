// The shapes every other file agrees on. See docs/DATA_MODEL.md for the reasoning.

/** A point in the walkable network. Corridors are chains of these. */
export type Node = {
  id: string;
  lat: number;
  lon: number;
  floor: number;
  /** Metres above the ground-floor datum. Unused today; AR needs a real height. */
  elevation: number;
  type: 'corridor' | 'junction' | 'door' | 'stair' | 'elevator' | 'entrance';
  /** Stairwells and lifts carry a shared label, e.g. "STAIR 4", so the floors link. */
  vertical?: string;
};

/**
 * A walkable connection. Undirected -- people walk hallways both ways, so the
 * router treats `from`/`to` as interchangeable and we never store the reverse.
 */
export type Edge = {
  id: string;
  from: string;
  to: string;
  /** COMPUTED from coordinates, never authored. Hand-entered lengths drift. */
  meters: number;
  kind: 'hallway' | 'stair' | 'elevator' | 'door';
};

/** A destination someone searches for. */
export type Room = {
  number: string;
  name?: string;
  floor: number;
  /** Where a route to this room ends. */
  doorNodeId: string;
};

/** A printed QR sticker. Scanning one resets position, floor and heading. */
export type Anchor = {
  id: string;
  nodeId: string;
  /** Degrees clockwise from north -- the way you face when reading it. */
  facingBearing: number;
  /** Metres off the floor. Unused today; AR needs it to place the arrow. */
  heightMeters: number;
};

/** Everything needed to draw and route one building. */
export type BuildingData = {
  id: string;
  name: string;
  /** Projection origin. Fixed per building so metres stay comparable. */
  origin: { lat: number; lon: number };
  floors: number[];
  nodes: Node[];
  edges: Edge[];
  rooms: Room[];
  anchors: Anchor[];
};
