import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
  },
  // Until now vitest ran with no `test` block at all, so it defaulted to the node
  // environment and nothing in this repo could be render-tested. Every auth defect this
  // month has lived in component wiring — a guard that fires too early, a second
  // getSession() racing the first — which is exactly the class a pure-function test cannot
  // reach. `environment: 'jsdom'` is opt-in per file via the docblock pragma so the existing
  // node-environment tests keep running unchanged and pay no startup cost.
  // A file opts in with the docblock pragma `// @vitest-environment jsdom` on its first line.
  test: {
    environment: 'node',
  },
})
