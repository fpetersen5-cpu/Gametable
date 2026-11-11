import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Only the runtime exports are tracked. Fail the build loudly if a clean clone
// is missing them instead of shipping a renderer whose 3D scene cannot load.
const runtimeDir = fileURLToPath(new URL('../../assets/mafia/runtime', import.meta.url));
const characterDir = join(runtimeDir, 'mafia-characters');
const manifestFile = join(characterDir, 'manifest.json');
if (!existsSync(manifestFile)) {
  throw new Error(
    'Mafia runtime assets are missing: expected assets/mafia/runtime/mafia-characters/manifest.json. ' +
      'Only runtime/ is tracked in git; see assets/mafia/README.md.',
  );
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
  characters?: Array<{ name?: unknown }>;
};
const names = (manifest.characters ?? [])
  .map((entry) => entry.name)
  .filter((name): name is string => typeof name === 'string' && name.length > 0);
if (names.length === 0) {
  throw new Error('Mafia runtime manifest lists no characters.');
}
const missing = names.filter(
  (name) =>
    !existsSync(join(characterDir, `${name}.gltf`)) ||
    !existsSync(join(characterDir, `${name}.bin`)),
);
if (missing.length > 0) {
  throw new Error(
    `Mafia runtime assets are incomplete; missing .gltf/.bin for: ${missing.join(', ')}.`,
  );
}

export default defineConfig({
  root: 'renderer',
  base: './',
  publicDir: runtimeDir,
  plugins: [react()],
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
