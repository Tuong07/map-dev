#!/usr/bin/env node
// Replays a recorded walk through the SAME detectors the browser pages use, so
// tuning happens at a desk instead of in a hallway.
//
//   node probes/analyze.mjs walk-01.json
//   node probes/analyze.mjs walk-01.json --sweep
//   node probes/analyze.mjs walk-01.json --high 11.4 --gap 300 --truth 100

import { readFileSync, writeFileSync } from 'node:fs';
import {
  StepDetector, TurnTracker, estimateGyroBias,
  yawRateAboutVertical, GravityFilter, AxisResolver,
} from './core.mjs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? parseFloat(argv[i + 1]) : dflt;
};
const has = (name) => argv.includes('--' + name);

if (!file) {
  console.error('usage: node probes/analyze.mjs <recording.json> [--sweep] [--high N] [--gap N] [--truth N]');
  process.exit(1);
}

const rec = JSON.parse(readFileSync(file, 'utf8'));
// record.html writes `samples`; the turns.html walk dump writes `trace`.
const S = rec.samples || rec.trace || [];
if (!S.length) { console.error('No samples in that file.'); process.exit(1); }

const truth = flag('truth', rec.groundTruthSteps ?? null);
const durSec = S[S.length - 1].t / 1000;
const hz = S.length / durSec;

// turns.html already measured bias properly, during a deliberate 10 s hold --
// trust that over re-deriving it. For record.html files there's no stored value,
// so fall back to the opening 2 s, which is someone standing still after tapping
// start. That fallback is only as good as how still they actually were.
const bias = rec.gyroBias || estimateGyroBias(S, { fromMs: 0, toMs: 2000 });

function run(opts) {
  const det = new StepDetector(opts);
  const tt = new TurnTracker();
  const grav = new GravityFilter(0.7);
  const axes = new AxisResolver();
  let last = 0;
  for (const s of S) {
    const dt = last ? Math.max(0, Math.min((s.t - last) / 1000, 0.1)) : 1 / hz;
    last = s.t;
    const accel = { x: s.ax, y: s.ay, z: s.az };
    const rot = { alpha: s.ra, beta: s.rb, gamma: s.rg };

    // Mirror the browser pipeline exactly, or tuning here won't transfer there.
    grav.push(accel, dt);
    axes.push(rot, grav, dt);
    det.push(s.ax, s.ay, s.az, s.t);
    tt.push(yawRateAboutVertical(rot, grav, bias, axes.map), dt, s.t);
  }
  return { steps: det.steps, turns: tt.turns, yaw: tt.yaw, axis: axes.name };
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
const mark = (ok) => (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m');
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

console.log('');
console.log(`  ${pad('file', 18)}${rec.label || file}`);
console.log(`  ${pad('recorded', 18)}${rec.recordedAt || '—'}`);
console.log(`  ${pad('duration', 18)}${durSec.toFixed(1)} s`);
console.log(`  ${pad('samples', 18)}${S.length}  ${dim(`(${hz.toFixed(0)} Hz)`)}`);
const biasMag = Math.hypot(bias.alpha, bias.beta, bias.gamma);
console.log(`  ${pad('gyro bias a/b/g', 18)}${bias.alpha.toFixed(2)} / ${bias.beta.toFixed(2)} / ${bias.gamma.toFixed(2)} deg/s  ${dim(`(${(biasMag * 60).toFixed(0)} deg drift/min)`)}`);
console.log(`  ${pad('gyro axis map', 18)}${run({}).axis}`);
console.log('');

if (has('sweep')) {
  if (!truth) { console.error('  --sweep needs ground truth. Use --truth N.'); process.exit(1); }
  console.log(`  ${pad('high', 8)}${pad('gap', 8)}${pad('steps', 8)}${pad('error', 10)}`);
  console.log(dim('  ' + '-'.repeat(34)));
  let best = null;
  for (let high = 10.4; high <= 13.01; high += 0.2) {
    for (let gap = 200; gap <= 420; gap += 40) {
      const r = run({ high, minGapMs: gap });
      const err = ((r.steps - truth) / truth) * 100;
      if (!best || Math.abs(err) < Math.abs(best.err)) best = { high, gap, steps: r.steps, err };
      if (Math.abs(err) <= 5) {
        console.log(`  ${pad(high.toFixed(1), 8)}${pad(gap, 8)}${pad(r.steps, 8)}${pad(err.toFixed(1) + '%', 10)}`);
      }
    }
  }
  console.log('');
  console.log(`  best: high=${best.high.toFixed(1)} gap=${best.gap} -> ${best.steps} steps (${best.err.toFixed(1)}%)`);
  console.log('');
  process.exit(0);
}

const opts = {
  high: flag('high', 11.0),
  low: flag('low', 9.9),
  minGapMs: flag('gap', 280),
  alpha: flag('alpha', 0.25),
};
const r = run(opts);

console.log(`  ${pad('steps found', 18)}${num(r.steps, 6)}`);
if (truth) {
  const err = ((r.steps - truth) / truth) * 100;
  console.log(`  ${pad('you counted', 18)}${num(truth, 6)}`);
  console.log(`  ${pad('error', 18)}${num(err.toFixed(1) + '%', 6)}  ${mark(Math.abs(err) <= 5)}`);
  if (Math.abs(err) > 5) {
    console.log(dim(`  ${' '.repeat(18)}${r.steps > truth ? 'over-counting — raise --high or --gap' : 'under-counting — lower --high'}`));
    console.log(dim(`  ${' '.repeat(18)}try: --sweep`));
  }
} else {
  console.log(dim(`  ${' '.repeat(18)}no ground truth — pass --truth N to score it`));
}
console.log('');

const dirs = r.turns.map((t) => t.dir).join(' ');
const expected = (rec.marks || []).length;
console.log(`  ${pad('turns found', 18)}${num(r.turns.length, 6)}`);
if (expected) {
  console.log(`  ${pad('corners marked', 18)}${num(expected, 6)}`);
  console.log(`  ${pad('match', 18)}${num('', 6)}  ${mark(r.turns.length === expected)}`);
}
if (r.turns.length) {
  console.log(`  ${pad('directions', 18)}${dirs}`);
  console.log(`  ${pad('angles', 18)}${r.turns.map((t) => t.deg + '°').join('  ')}`);
  const sum = r.turns.reduce((a, t) => a + t.deg, 0);
  console.log(`  ${pad('sum', 18)}${num(sum + '°', 6)}  ${dim('(a closed loop should be near ±360)')}`);
}
console.log('');

if (truth && Math.abs(((r.steps - truth) / truth) * 100) <= 5) {
  const tuned = { ...opts, gyroBias: +bias.toFixed(4), source: rec.label || file, at: new Date().toISOString() };
  writeFileSync(new URL('./tuned.json', import.meta.url), JSON.stringify(tuned, null, 2));
  console.log(dim('  tuned constants -> probes/tuned.json'));
  console.log('');
}
