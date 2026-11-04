import { expect, signInViaUi, signOutViaUi, test, HearerApi } from './fixtures.ts';

/**
 * Proves the harness: a fresh server, the setup wizard through the real UI against the mock
 * Jellyfin, signing out and back in, and a catalog search served by the MusicBrainz fixtures.
 * This spec runs first and leaves the server set up for the specs after it.
 */
test('setup wizard, sign in again, search', async ({ page, runtime }) => {
  const { admin, jellyfin } = runtime;

  await page.goto('/');
  // A fresh install sends everyone to the wizard.
  await expect(page).toHaveURL(/\/setup/);

  // 1. Administrator
  await expect(page.getByRole('heading', { name: 'Create the administrator' })).toBeVisible();
  await page.getByLabel('Username').fill(admin.username);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByLabel('Confirm password').fill(admin.password);
  await page.getByRole('button', { name: /Create account/ }).click();

  // 2. General
  await expect(page.getByLabel('Application title')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // 3. Media server: the connection test must reach the mock Jellyfin with the modern header.
  await page.getByLabel('Jellyfin URL').fill(jellyfin.url);
  await page.getByLabel('API key').fill(jellyfin.apiKey);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/Connected to/)).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // 4. Library and uploads: the temp directories global setup created are writable.
  await expect(page.getByLabel('Naming template')).toBeVisible();
  await expect(page.getByText(runtime.musicDir)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();

  // 5. Review and finish
  await expect(page.getByText('Review and finish')).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(/Welcome back/)).toBeVisible();

  // The wizard does not cover metadata settings, so point them at the mocks before searching.
  const api = new HearerApi(runtime);
  await api.loginAsAdmin();
  await api.pointMetadataAtMocks();
  await api.pointMediaServerAtMock();
  await api.addWebhookTarget();

  // Sign out, then sign in again as the local administrator.
  await signOutViaUi(page);
  await signInViaUi(page, admin.username, admin.password);
  await expect(page.getByText(/Welcome back/)).toBeVisible();

  // Search is served by the MusicBrainz fixture server.
  await page.goto('/search?q=OK%20Computer');
  await expect(page.getByText('OK Computer').first()).toBeVisible();
});
