import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const macOSChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.FF_CHROMIUM_EXECUTABLE
  || (existsSync(macOSChrome) ? macOSChrome : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5199',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 30000,
  },
  reporter: [['list']],
});
