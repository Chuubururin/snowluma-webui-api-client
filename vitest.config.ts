import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tools/**/*.test.ts', 'adapters/typescript/**/*.test.ts'], globals: false },
});
