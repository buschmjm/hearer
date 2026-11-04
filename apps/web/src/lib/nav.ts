import { Permission, hasPermission } from '@hearer/shared';
import {
  Home,
  Search,
  ListMusic,
  Upload,
  Library,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export type NavPath = '/' | '/search' | '/requests' | '/upload' | '/uploads' | '/admin';

export interface NavItem {
  to: NavPath;
  label: string;
  Icon: LucideIcon;
  /** Shown when the user holds any of these (ADMIN always). Omitted: every signed-in user. */
  anyOf?: readonly number[];
}

/**
 * Primary navigation. Only pages that exist are listed; later batches replace the stub routes
 * behind /search (H-17), /requests (H-18), /upload (H-19) and /admin (H-20).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Home', Icon: Home },
  { to: '/search', label: 'Search', Icon: Search },
  {
    to: '/requests',
    label: 'Requests',
    Icon: ListMusic,
    anyOf: [
      Permission.REQUEST,
      Permission.REQUEST_ALBUM,
      Permission.REQUEST_ARTIST,
      Permission.MANAGE_REQUESTS,
      Permission.VIEW_ALL_REQUESTS,
    ],
  },
  {
    to: '/upload',
    label: 'Upload',
    Icon: Upload,
    anyOf: [Permission.UPLOAD, Permission.MANAGE_UPLOADS],
  },
  {
    to: '/uploads',
    label: 'Uploads',
    Icon: Library,
    anyOf: [Permission.UPLOAD, Permission.MANAGE_UPLOADS],
  },
  {
    to: '/admin',
    label: 'Admin',
    Icon: ShieldCheck,
    anyOf: [
      Permission.MANAGE_SETTINGS,
      Permission.MANAGE_USERS,
      Permission.MANAGE_REQUESTS,
      Permission.MANAGE_UPLOADS,
    ],
  },
];

/** The nav entries a user with this permission bitmask may see. */
export function visibleNav(permissions: number): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => !item.anyOf || hasPermission(permissions, item.anyOf, { type: 'or' }),
  );
}
