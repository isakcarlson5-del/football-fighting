import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';

const MACOS_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Launch the bundled Playwright browser, or reuse local Chrome when its cache is absent. */
export function launchChromium() {
  const configured = process.env.FF_CHROMIUM_EXECUTABLE;
  const executablePath = configured || (existsSync(MACOS_CHROME) ? MACOS_CHROME : undefined);
  return chromium.launch(executablePath ? { executablePath } : undefined);
}
