import { defineConfig } from 'tsdown'

/** Host-only Cadre MCP catalog/selection plugin. */
export default defineConfig([{
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}])