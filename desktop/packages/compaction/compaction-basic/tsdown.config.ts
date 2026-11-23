import { defineConfig } from 'tsdown'

/** Builds each published entry as its own self-contained file; they never share a chunk. */
const entry = (file: string) => ({
  entry: [`lib/types/${file}.js`], outDir: 'lib', format: ['esm'] as const, platform: 'node' as const, target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})

export default defineConfig([entry('index'), entry('settings')])
