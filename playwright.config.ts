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
    launchOptions: executablePath ? { executablePath, args: ['--disable-audio-output'] } : undefined,
  },
  webServer: {
    command: 'node server/community-server.mjs --dev --ephemeral --port 5199 --admin-token test-vip-token-123456789 --no-rate-limit',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 30000,
  },
  reporter: [['list']],
});
