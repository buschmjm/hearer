/** Permission bitmask. ADMIN implies every other permission. */
export const Permission = {
  ADMIN: 1 << 0,
  MANAGE_USERS: 1 << 1,
  MANAGE_SETTINGS: 1 << 2,
  REQUEST: 1 << 3,
  REQUEST_ALBUM: 1 << 4,
  REQUEST_ARTIST: 1 << 5,
  AUTO_APPROVE: 1 << 6,
  MANAGE_REQUESTS: 1 << 7,
  UPLOAD: 1 << 8,
  AUTO_APPROVE_UPLOAD: 1 << 9,
  MANAGE_UPLOADS: 1 << 10,
  VIEW_ALL_REQUESTS: 1 << 11,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS: number = Object.values(Permission).reduce((a, b) => a | b, 0);

export const DEFAULT_USER_PERMISSIONS: number =
  Permission.REQUEST | Permission.REQUEST_ALBUM | Permission.UPLOAD;

export interface HasPermissionOptions {
  /** `and` (default): every required bit must be held. `or`: at least one. */
  type?: 'and' | 'or';
}

/**
 * Check a user's bitmask against one or more required permission bits.
 * ADMIN passes every check. An empty requirement is always satisfied.
 */
export function hasPermission(
  userPermissions: number,
  required: number | readonly number[],
  options: HasPermissionOptions = {},
): boolean {
  if ((userPermissions & Permission.ADMIN) !== 0) return true;
  const bits = typeof required === 'number' ? [required] : required;
  if (bits.length === 0) return true;
  const held = (bit: number): boolean => (userPermissions & bit) === bit;
  return options.type === 'or' ? bits.some(held) : bits.every(held);
}

/** Names of the permissions set in a bitmask (ADMIN is reported as itself only). */
export function permissionNames(mask: number): PermissionName[] {
  return (Object.keys(Permission) as PermissionName[]).filter(
    (name) => (mask & Permission[name]) !== 0,
  );
}

/** Whether a value is a valid bitmask of known permission bits. */
export function isValidPermissionMask(mask: number): boolean {
  return Number.isInteger(mask) && mask >= 0 && (mask & ~ALL_PERMISSIONS) === 0;
}
