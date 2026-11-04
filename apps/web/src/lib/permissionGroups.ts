import { ALL_PERMISSIONS, Permission, permissionNames, type PermissionName } from '@hearer/shared';

export interface PermissionChoice {
  bit: number;
  name: PermissionName;
  label: string;
  short: string;
  hint: string;
}

export interface PermissionGroup {
  id: 'requests' | 'uploads' | 'management' | 'admin';
  title: string;
  choices: PermissionChoice[];
}

const choice = (
  name: PermissionName,
  label: string,
  short: string,
  hint: string,
): PermissionChoice => ({ bit: Permission[name], name, label, short, hint });

/** Every permission bit, grouped for the editor. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    id: 'requests',
    title: 'Requests',
    choices: [
      choice('REQUEST', 'Request songs', 'Songs', 'Ask for individual tracks'),
      choice('REQUEST_ALBUM', 'Request albums', 'Albums', 'Ask for whole releases'),
      choice('REQUEST_ARTIST', 'Request artists', 'Artists', 'Ask for an artist catalog'),
      choice('AUTO_APPROVE', 'Auto-approve requests', 'Auto-approve', 'Skip the approval queue'),
      choice('VIEW_ALL_REQUESTS', 'See everyone’s requests', 'All requests', 'Not just their own'),
    ],
  },
  {
    id: 'uploads',
    title: 'Uploads',
    choices: [
      choice('UPLOAD', 'Upload music', 'Upload', 'Add files they own'),
      choice(
        'AUTO_APPROVE_UPLOAD',
        'Auto-approve uploads',
        'Auto-approve uploads',
        'Skip the upload review',
      ),
    ],
  },
  {
    id: 'management',
    title: 'Management',
    choices: [
      choice('MANAGE_REQUESTS', 'Manage requests', 'Manage requests', 'Approve, decline, retry'),
      choice('MANAGE_UPLOADS', 'Manage uploads', 'Manage uploads', 'Review and import uploads'),
      choice('MANAGE_USERS', 'Manage users', 'Manage users', 'Create, edit and remove accounts'),
      choice(
        'MANAGE_SETTINGS',
        'Manage settings',
        'Manage settings',
        'Server settings, jobs and integrations',
      ),
    ],
  },
  {
    id: 'admin',
    title: 'Administrator',
    choices: [choice('ADMIN', 'Administrator', 'Admin', 'Every permission, now and in the future')],
  },
];

/** The bits a user holding `permissions` may hand out (administrators: everything). */
export function grantableBits(permissions: number): number {
  return (permissions & Permission.ADMIN) !== 0 ? ALL_PERMISSIONS : permissions;
}

/** Everyday abilities; everything else counts as privileged (mirrors the server's guard). */
export const BASIC_PERMISSIONS =
  Permission.REQUEST | Permission.REQUEST_ALBUM | Permission.REQUEST_ARTIST | Permission.UPLOAD;

/** Whether the actor may edit or delete this user (the server refuses managing users above you). */
export function canManageUser(actorPermissions: number, targetPermissions: number): boolean {
  if ((actorPermissions & Permission.ADMIN) !== 0) return true;
  return (targetPermissions & ~BASIC_PERMISSIONS & ~actorPermissions) === 0;
}

const SHORT = new Map(PERMISSION_GROUPS.flatMap((g) => g.choices).map((c) => [c.name, c.short]));

/** Short labels for a user's permissions, for table cells. */
export function permissionSummary(mask: number): string[] {
  if ((mask & Permission.ADMIN) !== 0) return ['Admin'];
  return permissionNames(mask).map((name) => SHORT.get(name) ?? name);
}
