import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/layout',
  tsconfig: './tsconfig.app.json',
  use: { baseURL: 'http://127.0.0.1:4191', headless: true },
  webServer: [{ command: 'pnpm exec vite preview --host 127.0.0.1 --port 4191', url: 'http://127.0.0.1:4191', reuseExistingServer: !process.env.CI }, { command: 'pnpm exec vite --host 127.0.0.1 --port 5194 --strictPort', url: 'http://127.0.0.1:5194', reuseExistingServer: !process.env.CI }],
});
