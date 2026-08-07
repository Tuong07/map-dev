// Browser-only helpers. Sensor permissions, sample-rate metering, small DOM utils.

export const $ = (id) => document.getElementById(id);
export const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(d));

/**
 * iOS gates motion and orientation behind a prompt that MUST come from a real
 * user gesture -- it cannot fire on page load. Android grants both implicitly.
 * Returns { motion, orientation } each 'granted' | 'denied' | 'unsupported'.
 */
export async function requestSensors() {
  const out = { motion: 'granted', orientation: 'granted' };

  if (typeof DeviceMotionEvent === 'undefined') {
    out.motion = 'unsupported';
  } else if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try { out.motion = await DeviceMotionEvent.requestPermission(); }
    catch { out.motion = 'denied'; }
  }

  if (typeof DeviceOrientationEvent === 'undefined') {
    out.orientation = 'unsupported';
  } else if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { out.orientation = await DeviceOrientationEvent.requestPermission(); }
    catch { out.orientation = 'denied'; }
  }

  return out;
}

/** Counts events per second, so we can see the true sensor sample rate. */
export class RateMeter {
  constructor() { this.n = 0; this.hz = 0; this._t = performance.now(); }
  tick() {
    this.n++;
    const now = performance.now();
    const dt = now - this._t;
    if (dt >= 1000) { this.hz = (this.n * 1000) / dt; this.n = 0; this._t = now; }
  }
}

/** Stops the screen sleeping mid-walk. Safari 16.4+, Chrome. */
export async function keepAwake() {
  try { if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen'); }
  catch { /* non-fatal */ }
  return null;
}

/** Wires a range input to a readout element and a setter. */
export function slider(id, outId, onChange, digits = 2) {
  const inp = $(id);
  const apply = () => {
    const v = parseFloat(inp.value);
    $(outId).textContent = v.toFixed(digits);
    onChange(v);
  };
  inp.addEventListener('input', apply);
  apply();
  return inp;
}

/** Standard "Enable sensors" button behaviour, shared by every test page. */
export function onStart(btnId, handler) {
  const btn = $(btnId);
  btn.addEventListener('click', async () => {
    const perm = await requestSensors();
    if (perm.motion !== 'granted') {
      btn.textContent = 'Motion blocked: ' + perm.motion;
      btn.classList.add('bad-btn');
      return;
    }
    keepAwake();
    btn.textContent = 'Running';
    btn.className = 'secondary';
    btn.disabled = true;
    handler(perm);
  });
}

export function verdict(el, ok, okText, badText) {
  el.textContent = ok ? okText : badText;
  el.className = 'v ' + (ok ? 'good' : 'bad');
}
