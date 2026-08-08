import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Mirror the "@/*" alias from tsconfig.json. Vitest doesn't read tsconfig
    // paths on its own, so without this every "@/..." import fails to resolve.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    // Routing and positioning only -- no UI tests. See CLAUDE.md.
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
