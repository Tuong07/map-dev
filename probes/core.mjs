// Pure positioning math. No DOM, no browser APIs -- so the browser pages and the
// Node analysis script run the EXACT same code. Never import anything here.

/**
 * Step detector.
 *
 * Low-pass the acceleration magnitude, then find peaks with two guards:
 *   hysteresis  -- the signal must dip below `low` before another peak counts,
 *                  which stops one bouncy stride registering as three steps
 *   refractory  -- peaks closer together than `minGapMs` are ignored
 */
export class StepDetector {
  constructor({ high = 11.0, low = 9.9, minGapMs = 280, alpha = 0.25 } = {}) {
    Object.assign(this, { high, low, minGapMs, alpha });
    this.reset();
  }

  reset() {
    this.filtered = 9.81;
    this.armed = true;
    this.lastStepAt = -1e9;
    this.steps = 0;
  }

  /** Feed accelerationIncludingGravity. Returns true on the frame a step fires. */
  push(x, y, z, tMs) {
    const mag = Math.hypot(x || 0, y || 0, z || 0);
    this.filtered += this.alpha * (mag - this.filtered);

    if (this.filtered < this.low) this.armed = true;

    if (this.armed && this.filtered > this.high && tMs - this.lastStepAt > this.minGapMs) {
      this.armed = false;
      this.lastStepAt = tMs;
      this.steps++;
      return true;
    }
    return false;
  }
}

/**
 * Turn tracker.
 *
 * Integrates gyro yaw into a RELATIVE heading and classifies discrete turns.
 * Absolute heading never comes from here -- it comes from QR anchors and from
 * snapping to corridor bearings. All this answers is "did they turn, which way".
 * That is deliberately a much easier question than "which way are they facing".
 */
export class TurnTracker {
  constructor({ turnThresholdDeg = 60, settleMs = 400, moveRateDeg = 25, bias = 0 } = {}) {
    Object.assign(this, { turnThresholdDeg, settleMs, moveRateDeg, bias });
    this.reset();
  }

  reset() {
    this.yaw = 0;
    this.turns = [];
    this._segStart = 0;
    this._lastMoveAt = 0;
  }

  /** alphaRate = rotationRate.alpha in deg/s (yaw when the phone is flat, screen up). */
  push(alphaRate, dtSec, tMs) {
    const rate = (alphaRate || 0) - this.bias;
    this.yaw += rate * dtSec;

    if (Math.abs(rate) > this.moveRateDeg) {
      this._lastMoveAt = tMs;
      return null;
    }

    // Rotation settled -- decide whether the swing since the last settle was a turn.
    if (this._lastMoveAt && tMs - this._lastMoveAt > this.settleMs) {
      const delta = this.yaw - this._segStart;
      this._segStart = this.yaw;
      this._lastMoveAt = 0;
      if (Math.abs(delta) >= this.turnThresholdDeg) {
        const turn = { dir: delta > 0 ? 'L' : 'R', deg: Math.round(delta), at: tMs };
        this.turns.push(turn);
        return turn;
      }
    }
    return null;
  }
}

/** Estimates gyro drift (deg/s) from a stretch of samples recorded while stationary. */
export function estimateGyroBias(samples, { fromMs = 0, toMs = Infinity } = {}) {
  const slice = samples.filter((s) => s.t >= fromMs && s.t <= toMs);
  if (!slice.length) return 0;
  return slice.reduce((acc, s) => acc + (s.ra || 0), 0) / slice.length;
}

// ---------------------------------------------------------------------------
// Corridor graph
// ---------------------------------------------------------------------------

/** Bearing in degrees, clockwise from +y. Matches how we think about hallways. */
export const bearing = (a, b) => (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;

/** Signed smallest angle between two bearings, in [-180, 180]. */
export const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * A particle pinned to the corridor graph.
 *
 * Position is never free-floating (x, y) -- it is always "which edge, how far
 * along it". A student cannot walk through a wall, so neither can the dot, and
 * that single constraint is what keeps the error bounded.
 */
export class GraphTracker {
  /**
   * @param nodes  { id: {x, y} } in metres
   * @param edges  [{ id, from, to }]
   */
  constructor(nodes, edges) {
    this.nodes = nodes;
    this.edges = edges;
    this.byId = Object.fromEntries(edges.map((e) => [e.id, e]));
  }

  edgeLength(id) {
    const e = this.byId[id];
    return dist(this.nodes[e.from], this.nodes[e.to]);
  }

  edgeBearing(id) {
    const e = this.byId[id];
    return bearing(this.nodes[e.from], this.nodes[e.to]);
  }

  /** Drop the particle onto a known edge -- this is what a QR scan does. */
  anchor(edgeId, t = 0) {
    return {
      edgeId,
      t,
      heading: this.edgeBearing(edgeId),
      metersSinceAnchor: 0,
      metersTotal: 0,
    };
  }

  /** World position of a fix, for drawing. */
  toXY(fix) {
    const e = this.byId[fix.edgeId];
    const a = this.nodes[e.from];
    const b = this.nodes[e.to];
    return { x: a.x + (b.x - a.x) * fix.t, y: a.y + (b.y - a.y) * fix.t };
  }

  /** Pick the outgoing edge whose bearing best matches where we're pointed. */
  nextEdge(nodeId, cameFromId, heading) {
    let best = null;
    let bestErr = Infinity;
    for (const e of this.edges) {
      if (e.id === cameFromId) continue;
      let candidate = null;
      if (e.from === nodeId) candidate = e.id;
      else if (e.to === nodeId) candidate = e.id; // treat edges as walkable both ways
      if (!candidate) continue;

      const b = e.from === nodeId ? this.edgeBearing(e.id) : this.edgeBearing(e.id) + 180;
      const err = Math.abs(angleDiff(b, heading));
      if (err < bestErr) { bestErr = err; best = e.id; }
    }
    // A >120 degree mismatch means every exit points backwards -- they turned around.
    return bestErr > 120 ? null : best;
  }

  /**
   * Advance one step. Mutates and returns the fix.
   *
   * The important line is `fix.heading = this.edgeBearing(...)`: at every
   * junction we throw away the drifted gyro estimate and replace it with the
   * true bearing of the hallway. Gyro drift therefore never accumulates past a
   * single corridor segment.
   */
  step(fix, strideM, heading) {
    fix.heading = heading;
    fix.metersSinceAnchor += strideM;
    fix.metersTotal += strideM;
    fix.t += strideM / this.edgeLength(fix.edgeId);

    let guard = 0;
    while (fix.t > 1 && guard++ < 8) {
      const e = this.byId[fix.edgeId];
      const endNode = e.to;
      const carryM = (fix.t - 1) * this.edgeLength(fix.edgeId);
      const next = this.nextEdge(endNode, fix.edgeId, fix.heading);
      if (!next) { fix.t = 1; break; }
      fix.edgeId = next;
      fix.t = carryM / this.edgeLength(next);
      fix.heading = this.edgeBearing(next);
    }
    if (fix.t > 1) fix.t = 1;
    return fix;
  }
}

/** Honest uncertainty: grows with distance walked since the last known-good fix. */
export const driftRadius = (metersSinceAnchor, rate = 0.1, min = 1.5, max = 25) =>
  Math.min(max, Math.max(min, metersSinceAnchor * rate));
