/** Permission model lives in `@hearer/shared` so the web app shares it. */
export {
  ALL_PERMISSIONS,
  DEFAULT_USER_PERMISSIONS,
  Permission,
  hasPermission,
  isValidPermissionMask,
  permissionNames,
  type HasPermissionOptions,
  type PermissionName,
} from '@hearer/shared';
