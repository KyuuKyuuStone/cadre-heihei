import { defineConfig } from 'tsdown'

/** Host-only skill catalog/registration plugin. */
export default defineConfig([{
  entry: { index: 'lib/types/index.js', 'admin-plugin': 'lib/types/admin-plugin.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}])
