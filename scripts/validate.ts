// Checks map data on disk. Run before committing a trace, and in CI.
//
//   npm run validate
//   npm run validate -- wheatley

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateBuilding } from '../lib/core/validate';
import type { BuildingData } from '../lib/core/types';

const which = process.argv[2] ?? 'test-building';
const dir = join(process.cwd(), 'data', which);

if (!existsSync(dir)) {
  console.error(`\n  No such building: data/${which}\n`);
  process.exit(1);
}

const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

const data: BuildingData = {
  ...read('meta.json'),
  nodes: read('nodes.json'),
  edges: read('edges.json'),
  rooms: read('rooms.json'),
  anchors: read('anchors.json'),
};

const problems = validateBuilding(data);
const errors = problems.filter((p) => p.severity === 'error');
const warnings = problems.filter((p) => p.severity === 'warning');

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

console.log(`\n  ${data.name}  ${dim(`data/${which}`)}`);
console.log(
  dim(
    `  ${data.nodes.length} nodes · ${data.edges.length} edges · ` +
      `${data.rooms.length} rooms · ${data.anchors.length} anchors · ` +
      `${data.floors.length} floor${data.floors.length === 1 ? '' : 's'}`,
  ),
);
console.log('');

for (const p of warnings) console.log(`  ${yellow('warning')}  ${p.message}`);
for (const p of errors) console.log(`  ${red('error')}    ${p.message}`);

if (errors.length === 0 && warnings.length === 0) console.log(`  ${green('All checks passed.')}`);
else console.log(`\n  ${errors.length} error(s), ${warnings.length} warning(s)`);
console.log('');

process.exit(errors.length ? 1 : 0);
