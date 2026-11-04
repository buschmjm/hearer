import { expect, signInViaUi, test } from './fixtures.ts';

test.describe('sign-in methods and permissions', () => {
  test.beforeEach(async ({ api }) => {
    await api.ensureSetUp();
  });

  test('a Jellyfin user signs in with default permissions minus upload, and is kept out of admin', async ({
    page,
    runtime,
  }) => {
    const { username, password } = runtime.jellyfin.user;
    await page.goto('/login');
    await page.getByRole('tab', { name: 'Jellyfin' }).click();
    await page.getByLabel('Jellyfin username').fill(username);
    await page.getByLabel('Jellyfin password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden();

    // Requesting is allowed (search and requests are in the navigation) but uploading is not.
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Search' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Requests' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Upload', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Uploads' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Admin' })).toHaveCount(0);

    const me = await page.request.get('/api/v1/auth/me');
    expect(me.ok()).toBe(true);
    const body = (await me.json()) as { permissions: string[]; user: { authType: string } };
    expect(body.user.authType).toBe('jellyfin');
    expect(body.permissions).toEqual(expect.arrayContaining(['REQUEST', 'REQUEST_ALBUM']));
    expect(body.permissions).not.toContain('UPLOAD');
    expect(body.permissions).not.toContain('ADMIN');

    // The admin index has nothing for this user; the admin pages themselves refuse, and so does
    // the API (403, not just hidden buttons).
    await page.goto('/admin');
    await expect(page.getByText('There is nothing for you to manage here.')).toBeVisible();
    await page.goto('/admin/users');
    await expect(
      page.getByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeVisible();
    for (const path of [
      '/users',
      '/settings',
      '/jobs',
      '/uploads/config',
      '/notifications/targets',
    ]) {
      const res = await page.request.get(`/api/v1${path}`);
      expect(res.status(), path).toBe(403);
    }
  });

  test('a wrong Jellyfin password is refused', async ({ page, runtime }) => {
    await page.goto('/login');
    await page.getByRole('tab', { name: 'Jellyfin' }).click();
    await page.getByLabel('Jellyfin username').fill(runtime.jellyfin.user.username);
    await page.getByLabel('Jellyfin password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a local user without permissions can sign in but not use admin or upload APIs', async ({
    api,
    page,
    runtime,
  }) => {
    await api.createUser('plain-user', 'plain-user-password-1', 0);
    await signInViaUi(page, 'plain-user', 'plain-user-password-1');
    for (const path of ['/users', '/settings', '/uploads/config']) {
      expect((await page.request.get(`/api/v1${path}`)).status(), path).toBe(403);
    }
    await page.goto('/admin/jobs');
    await expect(
      page.getByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeVisible();
    // Unauthenticated callers get 401, not 403.
    const anonymous = await fetch(`${runtime.baseUrl}/api/v1/users`);
    expect(anonymous.status).toBe(401);
  });
});
