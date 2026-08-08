import { describe, it, expect } from 'vitest';
import { projectOntoSegment, autoLinkRooms } from '../autolink';

describe('projectOntoSegment', () => {
  const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };

  it('drops a perpendicular onto the segment', () => {
    const r = projectOntoSegment({ x: 4, y: 3 }, a, b);
    expect(r.point).toEqual({ x: 4, y: 0 });
    expect(r.distance).toBeCloseTo(3);
    expect(r.t).toBeCloseTo(0.4);
  });

  it('clamps past the end instead of projecting into empty space', () => {
    const r = projectOntoSegment({ x: 50, y: 0 }, a, b);
    expect(r.point).toEqual({ x: 10, y: 0 });   // the end, not x=50
    expect(r.t).toBe(1);
  });

  it('handles a zero-length segment without dividing by zero', () => {
    const r = projectOntoSegment({ x: 3, y: 4 }, a, a);
    expect(r.distance).toBeCloseTo(5);
  });
});

describe('autoLinkRooms', () => {
  const segments = [
    { id: 'north', a: { x: 0, y: 10 }, b: { x: 100, y: 10 } },
    { id: 'south', a: { x: 0, y: -10 }, b: { x: 100, y: -10 } },
  ];

  it('picks the nearer corridor, not merely the first', () => {
    const { links } = autoLinkRooms(
      [{ number: 'A', point: { x: 50, y: 6 } }, { number: 'B', point: { x: 50, y: -6 } }],
      segments,
    );
    expect(links.find((l) => l.roomNumber === 'A')!.segmentId).toBe('north');
    expect(links.find((l) => l.roomNumber === 'B')!.segmentId).toBe('south');
  });

  it('refuses to invent a door for a room with no corridor near it', () => {
    const { links, unlinked } = autoLinkRooms(
      [{ number: 'far', point: { x: 50, y: 500 } }],
      segments,
    );
    expect(links).toHaveLength(0);
    expect(unlinked).toEqual(['far']);
  });
});
