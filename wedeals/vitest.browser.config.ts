import { defineConfig } from "vitest/config";

// Testes no navegador (Playwright + Chromium headless). Rodam separados: `npm run test:browser`.
export default defineConfig({
  test: { environment: "node", pool: "forks", include: ["tests/browser/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
