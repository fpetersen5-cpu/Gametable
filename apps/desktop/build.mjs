import * as esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

await esbuild.build({
  ...shared,
  entryPoints: ['main/main.ts'],
  outfile: 'dist/main.cjs',
});

await esbuild.build({
  ...shared,
  entryPoints: ['main/preload.ts'],
  outfile: 'dist/preload.cjs',
});
