import { defineConfig } from 'tsup';

// One entry, published as both CommonJS (require) and ES modules (import),
// each with its own type declarations. Dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: 'node',
  target: 'node20',
  splitting: false,
});
