import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_USER_PERMISSIONS,
  hasPermission,
  isValidPermissionMask,
  notificationEventsFromMask,
  notificationEventsToMask,
  NOTIFICATION_EVENTS,
  Permission,
  permissionNames,
} from '../src/index.ts';

describe('Permission bits', () => {
  it('are distinct single bits', () => {
    const values = Object.values(Permission);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v & (v - 1)).toBe(0);
  });

  it('default new-user permissions are REQUEST | REQUEST_ALBUM | UPLOAD', () => {
    expect(DEFAULT_USER_PERMISSIONS).toBe(
      Permission.REQUEST | Permission.REQUEST_ALBUM | Permission.UPLOAD,
    );
    expect(permissionNames(DEFAULT_USER_PERMISSIONS)).toEqual([
      'REQUEST',
      'REQUEST_ALBUM',
      'UPLOAD',
    ]);
  });
});

describe('hasPermission', () => {
  const user = Permission.REQUEST | Permission.UPLOAD;

  it('requires all bits by default (and)', () => {
    expect(hasPermission(user, Permission.REQUEST)).toBe(true);
    expect(hasPermission(user, [Permission.REQUEST, Permission.UPLOAD])).toBe(true);
    expect(hasPermission(user, [Permission.REQUEST, Permission.MANAGE_USERS])).toBe(false);
    expect(
      hasPermission(user, [Permission.REQUEST, Permission.MANAGE_USERS], { type: 'and' }),
    ).toBe(false);
  });

  it('accepts any bit with or', () => {
    expect(hasPermission(user, [Permission.MANAGE_USERS, Permission.UPLOAD], { type: 'or' })).toBe(
      true,
    );
    expect(
      hasPermission(user, [Permission.MANAGE_USERS, Permission.MANAGE_SETTINGS], { type: 'or' }),
    ).toBe(false);
  });

  it('treats a combined mask as all-of', () => {
    expect(hasPermission(user, Permission.REQUEST | Permission.UPLOAD)).toBe(true);
    expect(hasPermission(user, Permission.REQUEST | Permission.MANAGE_USERS)).toBe(false);
  });

  it('lets ADMIN pass everything', () => {
    expect(hasPermission(Permission.ADMIN, ALL_PERMISSIONS)).toBe(true);
    expect(hasPermission(Permission.ADMIN, Permission.MANAGE_SETTINGS)).toBe(true);
    expect(hasPermission(Permission.ADMIN, [Permission.UPLOAD], { type: 'or' })).toBe(true);
  });

  it('denies users with no permissions, and passes an empty requirement', () => {
    expect(hasPermission(0, Permission.REQUEST)).toBe(false);
    expect(hasPermission(0, [], { type: 'or' })).toBe(true);
    expect(hasPermission(0, [])).toBe(true);
  });
});

describe('isValidPermissionMask', () => {
  it('rejects unknown bits, negatives and non-integers', () => {
    expect(isValidPermissionMask(ALL_PERMISSIONS)).toBe(true);
    expect(isValidPermissionMask(0)).toBe(true);
    expect(isValidPermissionMask(ALL_PERMISSIONS + 1 + ALL_PERMISSIONS)).toBe(false);
    expect(isValidPermissionMask(-1)).toBe(false);
    expect(isValidPermissionMask(1.5)).toBe(false);
  });
});

describe('notification event masks', () => {
  it('round trip and ignore unknown bits', () => {
    const events = ['request.available', 'upload.failed'] as const;
    const mask = notificationEventsToMask(events);
    expect(notificationEventsFromMask(mask)).toEqual(events);
    expect(notificationEventsFromMask(0)).toEqual([]);
    expect(notificationEventsFromMask(2 ** NOTIFICATION_EVENTS.length - 1)).toEqual([
      ...NOTIFICATION_EVENTS,
    ]);
  });
});
