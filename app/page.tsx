'use client';

import { useMemo, useState } from 'react';
import { building, buildingData, entrances } from '@/lib/building';
import { normalizeRoomNumber } from '@/lib/core/graph';
import { describeRoute, summarize } from '@/lib/core/directions';
import { FloorMap } from '@/components/FloorMap';

export default function Home() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [startId, setStartId] = useState(entrances[0]?.id ?? '');
  const [avoidStairs, setAvoidStairs] = useState(false);
  const [floor, setFloor] = useState(buildingData.floors[0]);

  /**
   * Matches on the number first, then the name, so typing "T1-002" beats a room
   * merely called something similar. Substring rather than fuzzy: people type the
   * beginning of a room number, not an approximation of it.
   */
  const matches = useMemo(() => {
    const q = normalizeRoomNumber(query);
    if (!q) return [];
    return buildingData.rooms
      .filter(
        (r) =>
          normalizeRoomNumber(r.number).includes(q) ||
          (r.name ?? '').toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 6);
  }, [query]);

  const room = selected ? buildingData.rooms.find((r) => r.number === selected) : null;

  const route = useMemo(() => {
    if (!room || !startId) return null;
    return building.route(startId, room.doorNodeId, { avoidStairs });
  }, [room, startId, avoidStairs]);

  const steps = useMemo(() => (route ? describeRoute(building, route) : []), [route]);

  function choose(number: string) {
    const r = buildingData.rooms.find((x) => x.number === number);
    if (!r) return;
    setSelected(number);
    setQuery(number);
    setFloor(r.floor);
  }

  function clear() {
    setSelected(null);
    setQuery('');
  }

  return (
    <main className="flex h-dvh flex-col">
      {/* Search */}
      <div className="relative z-10 border-b border-[var(--line)] bg-white px-4 pb-3 pt-4">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            placeholder="Room number, e.g. T1-002"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-xl border border-[var(--line)] px-4 py-3 text-base outline-none focus:border-[var(--accent)]"
          />
          {query && (
            <button
              onClick={clear}
              className="rounded-xl border border-[var(--line)] px-4 text-sm text-[var(--muted)]"
            >
              Clear
            </button>
          )}
        </div>

        {matches.length > 0 && !selected && (
          <ul className="absolute left-4 right-4 mt-2 overflow-hidden rounded-xl border border-[var(--line)] bg-white shadow-lg">
            {matches.map((r) => (
              <li key={r.number}>
                <button
                  onClick={() => choose(r.number)}
                  className="flex w-full items-baseline justify-between border-b border-[var(--line)] px-4 py-3 text-left last:border-0 active:bg-neutral-50"
                >
                  <span className="font-medium">{r.number}</span>
                  <span className="text-sm text-[var(--muted)]">
                    {r.name} · level {r.floor}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {query && matches.length === 0 && !selected && (
          <p className="mt-2 text-sm text-[var(--muted)]">No room matches “{query}”.</p>
        )}
      </div>

      {/* Map */}
      <div className="relative min-h-0 flex-1 bg-white">
        <FloorMap
          graph={building}
          floor={floor}
          route={route}
          destinationNodeId={room?.doorNodeId}
          startNodeId={startId}
        />

        {/* Floor switcher */}
        {buildingData.floors.length > 1 && (
          <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-white">
            {buildingData.floors.map((f) => (
              <button
                key={f}
                onClick={() => setFloor(f)}
                className={`h-11 w-11 border-b border-[var(--line)] text-sm last:border-0 ${
                  f === floor ? 'bg-[var(--accent)] font-semibold text-white' : 'text-[var(--muted)]'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        )}

        {route && route.floors.length > 1 && (
          <div className="absolute left-3 top-3 rounded-lg bg-[var(--accent)]/10 px-3 py-1.5 text-xs font-medium text-[var(--accent)]">
            Route crosses levels {route.floors.join(' → ')}
          </div>
        )}
      </div>

      {/* Directions */}
      <div className="safe-bottom max-h-[45%] overflow-y-auto border-t border-[var(--line)] bg-white px-4 pb-4 pt-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="text-sm text-[var(--muted)]">Start</label>
          <select
            value={startId}
            onChange={(e) => setStartId(e.target.value)}
            className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
          >
            {entrances.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}
              </option>
            ))}
          </select>

          <label className="ml-auto flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={avoidStairs}
              onChange={(e) => setAvoidStairs(e.target.checked)}
            />
            Step-free
          </label>
        </div>

        {!room && (
          <p className="py-6 text-center text-sm text-[var(--muted)]">
            Search for a room to get directions.
          </p>
        )}

        {room && !route && (
          <p className="py-6 text-center text-sm text-red-600">
            No route to {room.number}
            {avoidStairs && ' without stairs'}.
          </p>
        )}

        {room && route && (
          <>
            <div className="mb-2">
              <div className="text-lg font-semibold">
                {room.number}
                {room.name && <span className="font-normal text-[var(--muted)]"> · {room.name}</span>}
              </div>
              <div className="text-sm text-[var(--muted)]">{summarize(route)}</div>
            </div>
            <ol className="divide-y divide-[var(--line)]">
              {steps.map((s, i) => (
                <li key={i} className="flex items-baseline gap-3 py-2.5">
                  <span className="w-5 shrink-0 text-sm text-[var(--muted)]">{i + 1}</span>
                  <span className="text-[15px]">{s.text}</span>
                </li>
              ))}
              <li className="flex items-baseline gap-3 py-2.5">
                <span className="w-5 shrink-0 text-sm text-[var(--muted)]">{steps.length + 1}</span>
                <span className="text-[15px] font-medium">Arrive at {room.number}</span>
              </li>
            </ol>
          </>
        )}
      </div>
    </main>
  );
}
