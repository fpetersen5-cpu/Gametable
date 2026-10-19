#!/usr/bin/env node
/**
 * Plugin-boundary lint (M2c): game-specific branching outside packages/games-*
 * is how plugin systems rot. Any `gameId === 'x'` comparison in the engine,
 * agent, stats or app layers fails the build.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const allowed = ['packages/games-', 'packages/sdk-conformance/'];
const skipped = ['node_modules', 'dist', '.git'];
// Only comparisons against a literal game id are a boundary violation;
// `record.gameId === requestedGame` is a legitimate parameterised query.
const patterns = [
  /gameId\s*[!=]==\s*['"`]/,
  /['"`][^'"`]*['"`]\s*[!=]==\s*(?:[A-Za-z_$][\w$]*\.)?gameId\b/,
];

const offenders = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skipped.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) continue;
    const rel = relative(root, full);
    if (rel === 'scripts/check-game-branching.mjs') continue;
    if (allowed.some((prefix) => rel.startsWith(prefix))) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
    const text = await readFile(full, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (patterns.some((p) => p.test(line))) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}

await walk(root);

if (offenders.length > 0) {
  console.error('Game-specific branching outside packages/games-*:');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log('plugin boundary: clean');
