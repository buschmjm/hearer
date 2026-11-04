import { describe, expect, it } from 'vitest';
import {
  Permission,
  createUserRequestSchema,
  setupAdminRequestSchema,
  updateUserRequestSchema,
  userDtoSchema,
  usernameSchema,
} from '../src/index.ts';

describe('auth DTO schemas', () => {
  it('accepts sensible usernames and rejects odd ones', () => {
    for (const ok of ['abc', 'Jane.Doe', 'a_b-c', 'me@example.com', ' padded ']) {
      expect(usernameSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['ab', '', '.dot', 'has space', 'semi;colon', 'x'.repeat(65)]) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('bounds passwords and does not trim them', () => {
    const base = { username: 'admin' };
    expect(setupAdminRequestSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(setupAdminRequestSchema.safeParse({ ...base, password: 'x'.repeat(129) }).success).toBe(
      false,
    );
    const padded = setupAdminRequestSchema.parse({ ...base, password: '  spaces ok  ' });
    expect(padded.password).toBe('  spaces ok  ');
  });

  it('validates permission masks on create and update', () => {
    const base = { username: 'newuser', password: 'long enough pw' };
    expect(
      createUserRequestSchema.safeParse({ ...base, permissions: Permission.REQUEST }).success,
    ).toBe(true);
    expect(createUserRequestSchema.safeParse({ ...base, permissions: 1 << 20 }).success).toBe(
      false,
    );
    expect(updateUserRequestSchema.safeParse({}).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ requestQuotaLimit: null }).success).toBe(true);
    expect(updateUserRequestSchema.safeParse({ uploadQuotaDays: 0 }).success).toBe(false);
  });

  it('strips unknown fields such as a password hash from user DTOs', () => {
    const dto = userDtoSchema.parse({
      id: '1',
      username: 'u',
      email: null,
      displayName: null,
      avatar: null,
      authType: 'local',
      permissions: 1,
      requestQuotaLimit: null,
      requestQuotaDays: null,
      uploadQuotaMb: null,
      uploadQuotaDays: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      passwordHash: 'secret',
    });
    expect('passwordHash' in dto).toBe(false);
  });
});
