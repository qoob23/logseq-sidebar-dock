import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Logseq loads dist/index.html straight off disk, so every asset URL must be relative.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
