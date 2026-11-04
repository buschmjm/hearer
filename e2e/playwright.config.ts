import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Chromium only. In CI `playwright install` provides the browser. Locally the browser may come
 * from somewhere else (a pre-installed directory), selected by PLAYWRIGHT_CHROMIUM_PATH or found
 * under PLAYWRIGHT_BROWSERS_PATH / /opt/pw-browsers.
 */
function chromiumPath(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (fromEnv) return fromEnv;
  if (process.env.CI) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const candidate = `${root}/chromium`;
  return existsSync(candidate) ? candidate : undefined;
}

const executablePath = chromiumPath();

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // One server, one database: specs share state and run in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  outputDir: 'test-results',
  globalSetup: './global-setup.ts',
  use: {
    // baseURL is supplied per test by the `baseURL` fixture in fixtures.ts: the server's port is
    // only known once global setup has started it.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
