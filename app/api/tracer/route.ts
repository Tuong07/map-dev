// Load and save endpoints for the tracer.
//
// Development only. These write files to disk, which is impossible on Vercel
// anyway (read-only filesystem), and nothing about map authoring belongs in a
// production build. Both handlers 404 outside dev so the route cannot ship.

import { NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const devOnly = () =>
  process.env.NODE_ENV === 'development'
    ? null
    : NextResponse.json({ error: 'not found' }, { status: 404 });

const dirFor = (building: string, floor: string) =>
  join(process.cwd(), 'data', safe(building), `level-${safe(floor)}`);

/** Path segments come from the query string, so keep them to plain identifiers. */
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');

const readJson = (path: string) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;

export async function GET(request: Request) {
  const blocked = devOnly();
  if (blocked) return blocked;

  const url = new URL(request.url);
  const building = url.searchParams.get('building') ?? 'wheatley';
  const floor = url.searchParams.get('floor') ?? '1';
  const dir = dirFor(building, floor);

  const raw = readJson(join(dir, 'rooms.raw.json'));
  if (!raw) {
    return NextResponse.json(
      { error: `No rooms.raw.json for ${building} level ${floor}. Run extract-rooms first.` },
      { status: 404 },
    );
  }

  return NextResponse.json({
    raw,
    // A trace in progress, if one was saved earlier.
    trace: readJson(join(dir, 'trace.json')),
  });
}

export async function POST(request: Request) {
  const blocked = devOnly();
  if (blocked) return blocked;

  const body = await request.json();
  const building = safe(body.building ?? 'wheatley');
  const floor = safe(String(body.floor ?? '1'));
  const dir = dirFor(building, floor);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const write = (name: string, data: unknown) => {
    writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + '\n');
    written.push(name);
  };

  // trace.json is the tracer's own working state -- raw clicks in image pixels,
  // so a session can be reopened and edited. The nodes/edges/rooms files are the
  // derived output the app consumes.
  if (body.trace) write('trace.json', body.trace);
  if (body.nodes) write('nodes.json', body.nodes);
  if (body.edges) write('edges.json', body.edges);
  if (body.rooms) write('rooms.json', body.rooms);

  return NextResponse.json({ ok: true, written, dir: dir.replace(process.cwd() + '/', '') });
}
