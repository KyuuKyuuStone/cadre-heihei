import { defineConfig } from 'tsdown'

/** Node- and browser-safe library faces; consumers inline or import these entries. */
export default defineConfig([
  {
    entry: {
      index: 'lib/types/index.js',
      client: 'lib/types/client/index.js',
      host: 'lib/types/host/index.js',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
