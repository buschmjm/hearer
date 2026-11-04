import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ROLES,
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Harness,
} from './helpers/auth.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await completeSetup(h);
});
afterEach(async () => {
  await h.cleanup();
});

describe('PATCH /auth/me', () => {
  it('lets a local user edit their display name and email', async () => {
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    const res = await call(h.app, alice, 'PATCH', '/api/v1/auth/me', {
      displayName: 'Alice A',
      email: 'alice@example.test',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { displayName: string; email: string } }>().user).toMatchObject({
      displayName: 'Alice A',
      email: 'alice@example.test',
    });
    const me = await call(h.app, alice, 'GET', '/api/v1/auth/me');
    expect(me.json<{ user: { displayName: string } }>().user.displayName).toBe('Alice A');
  });

  it('can clear the email, and never touches permissions', async () => {
    await addUser(h.app, 'bob', ROLES.user);
    const bob = await login(h.app, 'bob');
    await call(h.app, bob, 'PATCH', '/api/v1/auth/me', { email: 'bob@example.test' });
    const cleared = await call(h.app, bob, 'PATCH', '/api/v1/auth/me', { email: null });
    expect(cleared.json<{ user: { email: string | null } }>().user.email).toBeNull();
    const sneaky = await call(h.app, bob, 'PATCH', '/api/v1/auth/me', {
      displayName: 'Bob',
      permissions: 1,
    });
    expect(sneaky.json<{ user: { permissions: number } }>().user.permissions).toBe(ROLES.user);
  });

  it('rejects an invalid email, an empty body, external accounts and anonymous calls', async () => {
    await addUser(h.app, 'carol', ROLES.user);
    const carol = await login(h.app, 'carol');
    expect(
      (await call(h.app, carol, 'PATCH', '/api/v1/auth/me', { email: 'nope' })).statusCode,
    ).toBe(400);
    expect((await call(h.app, carol, 'PATCH', '/api/v1/auth/me', {})).statusCode).toBe(400);
    expect(
      (await call(h.app, undefined, 'PATCH', '/api/v1/auth/me', { displayName: 'x' })).statusCode,
    ).toBe(401);

    const { user } = h.app.hearer.users.findOrCreateExternalUser('jellyfin', 'jf-1', {
      username: 'jelly',
    });
    const created = h.app.hearer.sessions.create(user.id);
    const external = { cookie: `hearer_session=${created.id}`, csrf: created.csrfToken };
    const res = await call(h.app, external, 'PATCH', '/api/v1/auth/me', { displayName: 'J' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('profile_not_editable');
  });
});
