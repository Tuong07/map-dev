// Turns a page of the Wheatley floor plan PDF into rooms.json plus a background
// image for the tracer.
//
//   npx tsx scripts/extract-rooms.ts --page 1 --floor 1
//
// Pipeline:
//   pdftoppm    render the page at high DPI
//   ocr.swift   Apple Vision -> text + pixel positions
//   this file   clean, pair labels, work out the scale, write JSON
//
// It does NOT produce corridors. Hallways are the empty space between walls --
// never drawn, so nothing can extract them. That is what the tracer is for.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toLatLon } from '../lib/core/geo';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const PDF = arg('pdf', '010-Wheatley.pdf');
const PAGE = parseInt(arg('page', '1'), 10);
const FLOOR = parseInt(arg('floor', String(PAGE)), 10);
const BUILDING = arg('building', 'wheatley');
const DPI = parseInt(arg('dpi', '300'), 10);

// Placeholder origin near Wheatley. We are deliberately NOT georeferenced yet --
// see docs/ARCHITECTURE.md. Distances are real; the building's position and
// rotation on Earth are approximate. Storing lat/lon anyway keeps the data model
// honest, so georeferencing later is a correction rather than a migration.
const ORIGIN = { lat: 42.3135, lon: -71.0378 };

type Ocr = { text: string; x: number; y: number; conf: number };

// ---------------------------------------------------------------------------

function render(): string {
  const dir = join('public', 'floorplans');
  mkdirSync(dir, { recursive: true });
  const stem = join(dir, `${BUILDING}-level-${FLOOR}`);
  console.log(`  rendering page ${PAGE} at ${DPI} dpi…`);
  execFileSync('pdftoppm', ['-r', String(DPI), '-png', '-f', String(PAGE), '-l', String(PAGE),
    '-singlefile', PDF, stem]);
  return stem + '.png';
}

function ocr(png: string): Ocr[] {
  console.log('  running Vision OCR…');
  const tsv = execFileSync('swift', ['tools/ocr.swift', png, '5'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return tsv.trim().split('\n').filter(Boolean).map((line) => {
    const [text, x, y, conf] = line.split('\t');
    return { text, x: +x, y: +y, conf: +conf };
  });
}

/**
 * Room labels sit inside a thin rectangle, and OCR reads that border as bracket
 * characters -- "[1-090]", "[1-077Y]]". Strip them, then accept only strings that
 * genuinely look like a room code.
 */
function asRoomNumber(raw: string, floor: number): string | null {
  let s = raw.trim().replace(/^[\[\]|Il]+/, '').replace(/[\[\]|Il]+$/, '').trim();
  // Level 2 subdivides open-plan offices as "2-142-3", so the trailing "-N" is
  // optional. Some plans also prefix a redundant zero: "01-077G" is "1-077G".
  const m = /^0?(\d)-(\d{2,3})(?:-(\d{1,2}))?([A-Z]{0,2})$/.exec(s);
  if (!m) return null;
  if (+m[1] !== floor) return null;         // a stray read from another sheet
  const sub = m[3] ? `-${m[3]}` : '';
  return `${m[1]}-${m[2].padStart(3, '0')}${sub}${m[4]}`;
}

const TYPE_WORDS = [
  'CLASSROOM', 'CLASS LAB', 'LABORATORY', 'LAB SERV', 'ENGINEERING LAB',
  'OFFICE', 'CONF. ROOM', 'CONFERENCE', 'CONF', 'SEMINAR', 'STUDY SPACE',
  'LOUNGE', 'LOBBY', 'VESTIBULE', 'AUDITORIUM', 'STAGE', 'STORAGE', 'STOR',
  'MECH', 'ELEC. ROOM', 'ELEC', 'DUCT', 'RESTROOM', 'TOILET', 'WOMEN', 'MEN',
  'ELEV', 'STAIR', 'SERVICE',
];

function classify(text: string): string | null {
  const up = text.toUpperCase().replace(/[^A-Z. ]/g, '').trim();
  for (const w of TYPE_WORDS) if (up.includes(w)) return w;
  return null;
}

/**
 * Scale, from the drawing's own scale bar.
 *
 * The title block prints a ruler labelled 0' 5' 10' 20' 30' 40'. Fitting a line
 * through where those numbers landed gives pixels-per-foot, which is how "34 m"
 * in the app becomes a real 34 metres. Without this every distance would be in
 * arbitrary units and A* would still route correctly but tell the user nothing.
 */
function pixelsPerMetre(items: Ocr[], imgWidth: number, imgHeight: number): number | null {
  const marks = items
    .filter((i) => i.x > imgWidth * 0.75 && i.y > imgHeight * 0.85)
    .map((i) => ({ ...i, feet: parseInt(i.text.replace(/[^0-9]/g, ''), 10) }))
    .filter((i) => [0, 5, 10, 20, 30, 40].includes(i.feet) && /^\d+'?$/.test(i.text.trim()));

  const byFeet = new Map<number, number>();
  for (const m of marks) if (!byFeet.has(m.feet)) byFeet.set(m.feet, m.x);
  if (byFeet.size < 3) return null;

  // Least-squares slope of x against feet.
  const pts = [...byFeet.entries()].map(([feet, x]) => ({ feet, x }));
  const n = pts.length;
  const mf = pts.reduce((a, p) => a + p.feet, 0) / n;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const num = pts.reduce((a, p) => a + (p.feet - mf) * (p.x - mx), 0);
  const den = pts.reduce((a, p) => a + (p.feet - mf) ** 2, 0);
  if (!den) return null;
  const pxPerFoot = num / den;
  return pxPerFoot > 0 ? pxPerFoot / 0.3048 : null;
}

// ---------------------------------------------------------------------------

const png = render();
const items = ocr(png);
const { width: imgW, height: imgH } = pngSize(png);
console.log(`  image ${imgW}x${imgH}, ${items.length} text items`);

const ppm = pixelsPerMetre(items, imgW, imgH);
console.log(ppm
  ? `  scale: ${ppm.toFixed(1)} px/m  (building is ${(imgW / ppm).toFixed(0)} m across the page)`
  : '  scale: NOT FOUND — falling back to page width');

// Rooms: a number, plus whatever type/area label sits nearest to it.
type Found = { number: string; x: number; y: number; conf: number };
const found = new Map<string, Found>();
for (const it of items) {
  const num = asRoomNumber(it.text, FLOOR);
  if (!num) continue;
  const prev = found.get(num);
  if (!prev || it.conf > prev.conf) found.set(num, { number: num, x: it.x, y: it.y, conf: it.conf });
}

const typeLabels = items
  .map((i) => ({ ...i, kind: classify(i.text) }))
  .filter((i): i is Ocr & { kind: string } => i.kind !== null);

const scale = ppm ?? imgW / 150;
const rooms = [...found.values()].map((r) => {
  let best: { kind: string; d: number } | null = null;
  for (const t of typeLabels) {
    const d = Math.hypot(t.x - r.x, t.y - r.y);
    if (d < 90 && (!best || d < best.d)) best = { kind: t.kind, d };
  }
  // Image y grows downward; metres y grows north, so flip it.
  const p = { x: r.x / scale, y: (imgH - r.y) / scale };
  const ll = toLatLon(p, ORIGIN);
  return {
    number: r.number,
    type: best?.kind ?? 'UNKNOWN',
    floor: FLOOR,
    lat: +ll.lat.toFixed(8),
    lon: +ll.lon.toFixed(8),
    px: { x: r.x, y: r.y },
    confidence: r.conf,
  };
}).sort((a, b) => a.number.localeCompare(b.number));

const dir = join('data', BUILDING, `level-${FLOOR}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'rooms.raw.json'), JSON.stringify({
  building: BUILDING,
  floor: FLOOR,
  source: `${PDF} page ${PAGE}`,
  extractedAt: new Date().toISOString(),
  origin: ORIGIN,
  georeferenced: false,
  image: { file: `/floorplans/${BUILDING}-level-${FLOOR}.png`, width: imgW, height: imgH },
  pixelsPerMetre: +scale.toFixed(4),
  rooms,
}, null, 2) + '\n');

const byType = rooms.reduce<Record<string, number>>((a, r) => {
  a[r.type] = (a[r.type] ?? 0) + 1; return a;
}, {});
console.log(`  wrote ${rooms.length} rooms -> ${dir}/rooms.raw.json`);
console.log('  by type:', Object.entries(byType).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v}`).join(', '));
const lowConf = rooms.filter((r) => r.confidence < 0.9);
if (lowConf.length) console.log(`  ${lowConf.length} low-confidence: ${lowConf.map((r) => r.number).join(', ')}`);

// ---------------------------------------------------------------------------

/** PNG dimensions live at a fixed offset in the IHDR chunk. No dependency needed. */
function pngSize(file: string): { width: number; height: number } {
  const buf = require('node:fs').readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
