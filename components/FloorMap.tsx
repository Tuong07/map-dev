'use client';

// The floor plan. Hand-drawn SVG rather than a mapping library -- see
// docs/ARCHITECTURE.md for why.

import { useMemo } from 'react';
import type { BuildingGraph, RouteResult } from '@/lib/core/graph';
import { floorViewBox, viewBoxAttr, plot, scaleFor } from '@/lib/render/floorplan';

type Props = {
  graph: BuildingGraph;
  floor: number;
  route: RouteResult | null;
  destinationNodeId?: string;
  startNodeId?: string;
};

export function FloorMap({ graph, floor, route, destinationNodeId, startNodeId }: Props) {
  const view = useMemo(() => floorViewBox(graph, floor), [graph, floor]);
  const s = scaleFor(view);

  const onThisFloor = (id: string) => graph.nodes.get(id)?.floor === floor;

  // Only the part of the route on the floor being shown. A route up a stairwell
  // draws as two separate runs, one per floor -- which is how someone walking it
  // actually experiences the journey.
  const routeEdgeIds = new Set(route?.edges.map((e) => e.id) ?? []);

  const roomByDoor = new Map(graph.data.rooms.map((r) => [r.doorNodeId, r]));
  const nodesOn = (type: string) =>
    graph.data.nodes.filter((n) => n.floor === floor && n.type === type);

  /**
   * Put a room's label on the far side of its door from the corridor, so labels
   * never sit on top of the hallway they belong to. Rooms on the south side of a
   * corridor get labels below; rooms on the north side get labels above.
   */
  function labelOffset(doorId: string): number {
    const door = graph.point(doorId);
    const neighbours = graph.adjacency.get(doorId) ?? [];
    const corridor = neighbours[0] ? graph.point(graph.other(neighbours[0], doorId)) : null;
    const doorIsNorth = corridor ? door.y > corridor.y : true;
    // Remember y is negated on screen: north is a smaller SVG y.
    return doorIsNorth ? -s.font * 0.9 : s.font * 1.5;
  }

  return (
    <svg
      viewBox={viewBoxAttr(view)}
      className="h-full w-full touch-none"
      role="img"
      aria-label={`Floor plan of level ${floor}`}
    >
      {/* Corridors */}
      {graph.data.edges.map((e) => {
        if (!onThisFloor(e.from) || !onThisFloor(e.to)) return null;
        const a = plot(graph.point(e.from));
        const b = plot(graph.point(e.to));
        const onRoute = routeEdgeIds.has(e.id);
        return (
          <line
            key={e.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={onRoute ? '#2563eb' : '#d4d4d8'}
            strokeWidth={onRoute ? s.route : s.corridor}
            strokeLinecap="round"
          />
        );
      })}

      {/* Stairs and lifts */}
      {[...nodesOn('stair'), ...nodesOn('elevator')].map((n) => {
        const p = plot(graph.point(n.id));
        return (
          <g key={n.id}>
            <rect
              x={p.x - s.marker / 2}
              y={p.y - s.marker / 2}
              width={s.marker}
              height={s.marker}
              rx={s.marker / 6}
              fill="#fff"
              stroke="#71717a"
              strokeWidth={s.corridor / 2}
            />
            <text
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={s.font * 0.55}
              fill="#71717a"
            >
              {n.type === 'stair' ? 'S' : 'L'}
            </text>
          </g>
        );
      })}

      {/* Entrances */}
      {nodesOn('entrance').map((n) => {
        const p = plot(graph.point(n.id));
        return (
          <circle
            key={n.id}
            cx={p.x}
            cy={p.y}
            r={s.node * 1.8}
            fill="#fff"
            stroke="#16a34a"
            strokeWidth={s.corridor}
          />
        );
      })}

      {/* Rooms */}
      {nodesOn('door').map((n) => {
        const p = plot(graph.point(n.id));
        const room = roomByDoor.get(n.id);
        const isDestination = n.id === destinationNodeId;
        return (
          <g key={n.id}>
            <circle
              cx={p.x}
              cy={p.y}
              r={isDestination ? s.marker / 2 : s.node}
              fill={isDestination ? '#2563eb' : '#a1a1aa'}
            />
            {room && (
              <text
                x={p.x}
                y={p.y + labelOffset(n.id)}
                textAnchor="middle"
                fontSize={s.font * (isDestination ? 0.85 : 0.62)}
                fontWeight={isDestination ? 600 : 400}
                fill={isDestination ? '#2563eb' : '#71717a'}
              >
                {room.number}
              </text>
            )}
          </g>
        );
      })}

      {/* Where the route begins on this floor */}
      {startNodeId && onThisFloor(startNodeId) && (
        <circle
          cx={plot(graph.point(startNodeId)).x}
          cy={plot(graph.point(startNodeId)).y}
          r={s.marker / 2.4}
          fill="#16a34a"
          stroke="#fff"
          strokeWidth={s.corridor}
        />
      )}
    </svg>
  );
}
