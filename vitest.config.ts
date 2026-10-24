import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@gametable/engine': pkg('engine'),
      '@gametable/agent': pkg('agent'),
      '@gametable/stats': pkg('stats'),
      '@gametable/sdk-conformance': pkg('sdk-conformance'),
      '@gametable/games-mafia': pkg('games-mafia'),
      '@gametable/games-buckshot': pkg('games-buckshot'),
      '@gametable/games-coup': pkg('games-coup'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
