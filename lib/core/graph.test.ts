// Tests on routing only -- that's where real bugs live. See CLAUDE.md.

import { describe, it, expect } from 'vitest';
import { building, buildingData } from '../building';
import { describeRoute } from './directions';
import { normalizeRoomNumber } from './graph';
import { validateBuilding } from './validate';

const room = (n: string) => building.roomByNumber(n)!;
const WEST = 'T1-E001';
const EAST = 'T1-E002';

describe('test building data', () => {
  it('passes every integrity check', () => {
    const errors = validateBuilding(buildingData).filter((p) => p.severity === 'error');
    expect(errors).toEqual([]);
  });
});

describe('room lookup', () => {
  it('matches however the number is typed', () => {
    for (const typed of ['T1-002', 't1-002', 'T1 002', 't1002', 'T1_002']) {
      expect(room(typed).name).toBe('Lecture Hall');
    }
  });

  it('returns nothing for a room that does not exist', () => {
    expect(building.roomByNumber('T9-999')).toBeUndefined();
  });

  it('normalises consistently', () => {
    expect(normalizeRoomNumber('T1-002')).toBe(normalizeRoomNumber('t1 002'));
  });
});

describe('routing', () => {
  it('finds a route on one floor', () => {
    const r = building.route(WEST, room('T1-002').doorNodeId)!;
    expect(r).not.toBeNull();
    expect(r.floors).toEqual([1]);
    // West entrance is 6 m out, then 10 m along the spine, then a 3 m door stub.
    expect(r.meters).toBeCloseTo(19, 0);
  });

  it('takes the shorter approach when starting from the other end', () => {
    const target = room('T1-014').doorNodeId; // 50 m along the 60 m spine
    const fromWest = building.route(WEST, target)!;
    const fromEast = building.route(EAST, target)!;
    expect(fromEast.meters).toBeLessThan(fromWest.meters);
  });

  it('crosses floors and reports both', () => {
    const r = building.route(WEST, room('T2-002').doorNodeId)!;
    expect(r.floors).toEqual([1, 2]);
    expect(r.edges.some((e) => e.kind === 'stair')).toBe(true);
  });

  it('prefers stairs to the lift when both are available', () => {
    const r = building.route(WEST, room('T2-002').doorNodeId)!;
    expect(r.edges.some((e) => e.kind === 'stair')).toBe(true);
    expect(r.edges.some((e) => e.kind === 'elevator')).toBe(false);
  });

  it('uses the lift when stairs are refused', () => {
    const r = building.route(WEST, room('T2-002').doorNodeId, { avoidStairs: true })!;
    expect(r).not.toBeNull();
    expect(r.edges.some((e) => e.kind === 'stair')).toBe(false);
    expect(r.edges.some((e) => e.kind === 'elevator')).toBe(true);
  });

  it('reaches every room from every entrance', () => {
    for (const entrance of ['T1-E001', 'T1-E002']) {
      for (const r of buildingData.rooms) {
        expect(building.route(entrance, r.doorNodeId), `${entrance} -> ${r.number}`).not.toBeNull();
      }
    }
  });

  it('returns null for an unknown node instead of throwing', () => {
    expect(building.route('nope', room('T1-002').doorNodeId)).toBeNull();
  });

  it('never reports a route shorter than the straight line', () => {
    // A* is only optimal if the heuristic never overestimates. If this fails,
    // the heuristic is wrong and routes may be suboptimal.
    const r = building.route(WEST, room('T1-014').doorNodeId)!;
    const a = building.point(WEST);
    const b = building.point(room('T1-014').doorNodeId);
    expect(r.meters).toBeGreaterThanOrEqual(Math.hypot(b.x - a.x, b.y - a.y) - 0.01);
  });
});

describe('directions', () => {
  it('merges a straight corridor into one instruction', () => {
    const r = building.route(WEST, room('T1-014').doorNodeId)!;
    const steps = describeRoute(building, r);
    // The spine is traced as six 10 m segments; it should not read as six steps.
    expect(steps.filter((s) => s.text.startsWith('Continue')).length).toBeLessThanOrEqual(3);
  });

  it('calls out the turn into a door', () => {
    const r = building.route(WEST, room('T1-002').doorNodeId)!;
    const steps = describeRoute(building, r);
    expect(steps.some((s) => /Turn (left|right)/.test(s.text))).toBe(true);
  });

  it('names the stairs and the destination floor', () => {
    const r = building.route(WEST, room('T2-002').doorNodeId)!;
    const steps = describeRoute(building, r);
    const stair = steps.find((s) => s.text.includes('stairs'));
    expect(stair?.text).toContain('STAIR 1');
    expect(stair?.text).toContain('level 2');
  });

  it('says lift, not stairs, on a step-free route', () => {
    const r = building.route(WEST, room('T2-002').doorNodeId, { avoidStairs: true })!;
    const steps = describeRoute(building, r);
    expect(steps.some((s) => s.text.includes('lift'))).toBe(true);
    expect(steps.some((s) => s.text.includes('stairs'))).toBe(false);
  });

  it('produces no zero-distance Continue steps', () => {
    for (const r of buildingData.rooms) {
      const route = building.route(WEST, r.doorNodeId)!;
      for (const s of describeRoute(building, route)) {
        if (s.text.startsWith('Continue')) expect(s.meters).toBeGreaterThan(0);
      }
    }
  });
});
