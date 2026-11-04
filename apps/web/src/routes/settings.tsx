import { Permission } from '@hearer/shared';
import { Link, Outlet } from '@tanstack/react-router';
import { PageFrame, RequirePermission } from '../components/admin/PageFrame.tsx';
import { AuthTab } from '../components/settings/AuthTab.tsx';
import { FulfillmentTab } from '../components/settings/FulfillmentTab.tsx';
import { GeneralTab } from '../components/settings/GeneralTab.tsx';
import { LibraryTab } from '../components/settings/LibraryTab.tsx';
import { MediaServerTab } from '../components/settings/MediaServerTab.tsx';
import { MetadataTab } from '../components/settings/MetadataTab.tsx';
import { NotificationsTab } from '../components/settings/NotificationsTab.tsx';

const TABS = [
  { to: '/admin/settings/general', label: 'General' },
  { to: '/admin/settings/auth', label: 'Sign-in' },
  { to: '/admin/settings/media-server', label: 'Media server' },
  { to: '/admin/settings/library', label: 'Library & uploads' },
  { to: '/admin/settings/metadata', label: 'Metadata' },
  { to: '/admin/settings/fulfillment', label: 'Fulfillment' },
  { to: '/admin/settings/notifications', label: 'Notifications' },
] as const;

export function SettingsLayout() {
  return (
    <RequirePermission anyOf={[Permission.MANAGE_SETTINGS]}>
      <PageFrame title="Settings" subtitle="Configure how Hearer works.">
        <nav
          aria-label="Settings sections"
          className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-line px-4 lg:mx-0 lg:px-0"
        >
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className="-mb-px shrink-0 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted hover:text-fg"
              activeProps={{ className: '!border-accent !text-accent' }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <Outlet />
      </PageFrame>
    </RequirePermission>
  );
}

export {
  AuthTab as AuthSettingsPage,
  FulfillmentTab as FulfillmentSettingsPage,
  GeneralTab as GeneralSettingsPage,
  LibraryTab as LibrarySettingsPage,
  MediaServerTab as MediaServerSettingsPage,
  MetadataTab as MetadataSettingsPage,
  NotificationsTab as NotificationsSettingsPage,
};
