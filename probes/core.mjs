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
  /**
   * @param adaptive  scale the threshold to how hard the person is actually
   *                  walking, instead of using one fixed number
   * @param k         peak must exceed the baseline by k x the recent wobble
   * @param minProm   floor on that margin, so standing still can't trigger steps
   * @param high/low  fixed thresholds, used only when adaptive is false
   */
  constructor({
    high = 11.0, low = 9.9, minGapMs = 280, alpha = 0.25,
    adaptive = true, k = 1.2, minProm = 0.3,
  } = {}) {
    Object.assign(this, { high, low, minGapMs, alpha, adaptive, k, minProm });
    this.reset();
  }

  reset() {
    this.filtered = 9.81;
    this.mu = 9.81;    // slow baseline -- settles on gravity
    this.dev = 0.3;    // slow mean absolute deviation -- how hard they're walking
    this.armed = true;
    this.lastStepAt = -1e9;
    this.steps = 0;
  }

  /** Current trigger level. Exposed so the test pages can plot it. */
  get threshold() {
    return this.adaptive ? this.mu + Math.max(this.minProm, this.k * this.dev) : this.high;
  }

  get rearm() {
    return this.adaptive ? this.mu : this.low;
  }

  /** Feed accelerationIncludingGravity. Returns true on the frame a step fires. */
  push(x, y, z, tMs) {
    const mag = Math.hypot(x || 0, y || 0, z || 0);
    this.filtered += this.alpha * (mag - this.filtered);

    // Baseline and wobble track much slower than the step signal, so a footfall
    // moves `filtered` without dragging the threshold up with it.
    //
    // This is what makes careful, screen-watching walking work. A fixed 11.0 was
    // tuned on brisk walking; walk gently and the peaks never reach it, so steps
    // vanish. Scaling the trigger to the recent signal keeps both gaits working.
    this.mu += 0.01 * (this.filtered - this.mu);
    this.dev += 0.01 * (Math.abs(this.filtered - this.mu) - this.dev);

    if (this.filtered < this.rearm) this.armed = true;

    if (this.armed && this.filtered > this.threshold && tMs - this.lastStepAt > this.minGapMs) {
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
  /**
   * @param turnThresholdDeg  net rotation that counts as a turn
   * @param windowMs          how far back to measure NET rotation
   * @param settleDeg         net rotation under this, across the window, = stopped
   */
  // windowMs defaults to 1000 for a physical reason: walking cadence is about
  // 2 steps/sec, so the body sways at ~1 Hz. A one-second window spans exactly
  // one full sway, which cancels to zero net rotation however big the sway is.
  constructor({ turnThresholdDeg = 50, windowMs = 1000, settleDeg = 15 } = {}) {
    Object.assign(this, { turnThresholdDeg, windowMs, settleDeg });
    this.reset();
  }

  reset() {
    this.yaw = 0;
    this.turns = [];
    this._hist = [];
    this._segStart = 0;
    this._turning = false;
  }

  /** yawRate in deg/s about TRUE vertical -- use yawRateAboutVertical() to get it. */
  push(yawRate, dtSec, tMs) {
    this.yaw += (yawRate || 0) * dtSec;

    this._hist.push({ t: tMs, y: this.yaw });
    while (this._hist.length > 1 && tMs - this._hist[0].t > this.windowMs) this._hist.shift();

    // NET rotation over the window, not instantaneous rate. This is the whole
    // trick: an arm swinging while you walk rotates one way then back, so its
    // net contribution is ~0 and it reads as standing still. A real turn keeps
    // going the same way, so net rotation grows. Watching instantaneous rate
    // instead can never separate the two -- walking noise alone reaches 60 deg/s.
    const net = this.yaw - this._hist[0].y;

    if (Math.abs(net) > this.settleDeg) { this._turning = true; return null; }

    if (this._turning) {
      this._turning = false;
      const delta = this.yaw - this._segStart;
      this._segStart = this.yaw;
      if (Math.abs(delta) >= this.turnThresholdDeg) {
        const turn = { dir: delta > 0 ? 'L' : 'R', deg: Math.round(delta), at: tMs };
        this.turns.push(turn);
        return turn;
      }
    }
    return null;
  }
}

/**
 * Yaw rate about TRUE vertical, whatever angle the phone is held at.
 *
 * The naive approach reads rotationRate.alpha, which is rotation about the axis
 * sticking out of the screen. That only equals "turning left/right" when the
 * phone lies flat like a tray. Tilt it up to read it -- which everyone does --
 * and the turn signal bleeds into gamma instead, so alpha reads near zero and
 * turns vanish.
 *
 * The fix: the accelerometer already tells us which way is down, because gravity
 * dominates it. Normalise that to a unit vector and project the rotation-rate
 * vector onto it. What survives is rotation about the real-world vertical axis,
 * which is exactly what "turning" means, at any phone angle.
 *
 * Axis mapping is easy to get wrong: rotationRate.beta is about x, .gamma about
 * y, .alpha about z. The leading minus matches WebKit's convention, where a
 * device resting screen-up reports roughly z = -9.8.
 */
/**
 * Pulls the gravity direction out of a noisy accelerometer stream.
 *
 * accelerationIncludingGravity is gravity PLUS whatever you're doing. Standing
 * still those are the same thing, so the raw reading points straight down. Walking
 * adds several m/s2 of footfall and sway, and the raw vector lurches around with
 * every step.
 *
 * Gravity is the one part that never changes, so a slow low-pass keeps it and
 * discards the rest. Everything downstream needs a stable "down" to measure
 * against -- feed it the raw vector and the reference axis wobbles once per step,
 * which quietly destroys the yaw estimate.
 */
export class GravityFilter {
  /** @param tau seconds of smoothing. ~0.7 keeps gravity, kills walking motion. */
  constructor(tau = 0.7) { this.tau = tau; this.x = 0; this.y = 0; this.z = 0; this._init = false; }

  push(accel, dtSec) {
    const ax = accel?.x || 0, ay = accel?.y || 0, az = accel?.z || 0;
    if (!this._init) { this.x = ax; this.y = ay; this.z = az; this._init = true; return this; }
    const a = Math.min(1, dtSec / this.tau);
    this.x += a * (ax - this.x);
    this.y += a * (ay - this.y);
    this.z += a * (az - this.z);
    return this;
  }
}

/**
 * Candidate mappings from the named rotationRate fields onto physical axes.
 *
 * The spec says alpha is rotation about z, beta about x, gamma about y. Real
 * devices do not all agree. On the iPhone this was tested against, gravity sits
 * squarely on z while body turns show up in GAMMA -- so gamma is that device's
 * z-axis rotation, and reading alpha gets you nothing but noise.
 *
 * Each entry returns [wx, wy, wz].
 */
export const AXIS_MAPS = {
  spec: (r) => [r.beta || 0, r.gamma || 0, r.alpha || 0],
  altA: (r) => [r.alpha || 0, r.beta || 0, r.gamma || 0],
  altB: (r) => [r.gamma || 0, r.beta || 0, r.alpha || 0],
  altC: (r) => [r.beta || 0, r.alpha || 0, r.gamma || 0],
};

/**
 * Works out which mapping a device actually uses, from physics alone.
 *
 * As a device rotates, the gravity vector measured in DEVICE coordinates rotates
 * the opposite way:   dg/dt = -(omega x g)
 *
 * Both sides are measurable -- gravity from the accelerometer, omega from the
 * gyroscope -- so we can score each candidate mapping by how well it predicts
 * the gravity motion we actually observed, and keep the winner. No user-agent
 * sniffing, no hardcoded per-platform table, and it stays correct on hardware
 * that didn't exist when this was written.
 *
 * Only samples taken while genuinely rotating count: standing still, every
 * mapping predicts "gravity isn't moving" and the comparison is pure noise.
 */
export class AxisResolver {
  // Lock in fast. The winning mapping beats the others by ~4x, so a handful of
  // rotating samples is plenty -- and every sample spent deciding is a sample
  // measured with the wrong axis, which is how the very first turn gets lost.
  constructor({ gateDeg = 45, minSamples = 15 } = {}) {
    this.gateDeg = gateDeg;
    this.minSamples = minSamples;
    this.names = Object.keys(AXIS_MAPS);
    this.err = Object.fromEntries(this.names.map((n) => [n, 0]));
    this.n = 0;
    this._prev = null;
  }

  push(rot, grav, dtSec) {
    const g = { x: grav?.x || 0, y: grav?.y || 0, z: grav?.z || 0 };
    const prev = this._prev;
    this._prev = g;
    if (!prev || dtSec <= 0) return;

    if (Math.hypot(rot?.alpha || 0, rot?.beta || 0, rot?.gamma || 0) < this.gateDeg) return;

    const D = Math.PI / 180;
    const obs = [(g.x - prev.x) / dtSec, (g.y - prev.y) / dtSec, (g.z - prev.z) / dtSec];

    for (const name of this.names) {
      const [wx, wy, wz] = AXIS_MAPS[name](rot).map((v) => v * D);
      const pred = [
        -(wy * prev.z - wz * prev.y),
        -(wz * prev.x - wx * prev.z),
        -(wx * prev.y - wy * prev.x),
      ];
      this.err[name] += Math.hypot(pred[0] - obs[0], pred[1] - obs[1], pred[2] - obs[2]);
    }
    this.n++;
  }

  /** Until enough rotation has been seen, fall back to the spec mapping. */
  get confident() { return this.n >= this.minSamples; }
  get name() {
    if (!this.confident) return 'spec';
    return this.names.reduce((a, b) => (this.err[b] < this.err[a] ? b : a));
  }
  get map() { return AXIS_MAPS[this.name]; }
}

export function yawRateAboutVertical(rot, accel, bias = null, mapFn = AXIS_MAPS.spec) {
  const ax = accel?.x || 0, ay = accel?.y || 0, az = accel?.z || 0;
  const mag = Math.hypot(ax, ay, az);
  if (mag < 1e-6) return 0;

  // Bias comes off each NAMED axis first -- it's measured in that space. Only
  // then do we map onto physical axes and project. Correcting the projected
  // scalar instead only holds at the tilt it was measured at.
  const d = {
    alpha: (rot?.alpha || 0) - (bias?.alpha || 0),
    beta: (rot?.beta || 0) - (bias?.beta || 0),
    gamma: (rot?.gamma || 0) - (bias?.gamma || 0),
  };
  const [wx, wy, wz] = mapFn(d);

  return -((wx * ax + wy * ay + wz * az) / mag);
}

/**
 * Estimates gyro drift from a stretch of samples recorded while stationary.
 * Returns deg/s PER AXIS -- bias differs between axes, and a single averaged
 * number only cancels out at the exact tilt it was measured at.
 */
export function estimateGyroBias(samples, { fromMs = 0, toMs = Infinity } = {}) {
  if (!samples.length) return { alpha: 0, beta: 0, gamma: 0 };
  // Window is relative to the FIRST sample. record.html timestamps start at 0,
  // but turns.html stores raw e.timeStamp, which starts wherever the page did.
  const t0 = samples[0].t;
  const slice = samples.filter((s) => s.t - t0 >= fromMs && s.t - t0 <= toMs);
  if (!slice.length) return { alpha: 0, beta: 0, gamma: 0 };
  const sum = slice.reduce(
    (a, s) => ({ alpha: a.alpha + (s.ra || 0), beta: a.beta + (s.rb || 0), gamma: a.gamma + (s.rg || 0) }),
    { alpha: 0, beta: 0, gamma: 0 },
  );
  return { alpha: sum.alpha / slice.length, beta: sum.beta / slice.length, gamma: sum.gamma / slice.length };
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
