import { Permission } from '@hearer/shared';
import { Link } from '@tanstack/react-router';
import { Activity, ListMusic, Settings, Upload, Users, type LucideIcon } from 'lucide-react';
import { useAuth } from '../api/auth.ts';
import { PageFrame } from '../components/admin/PageFrame.tsx';
import { Card } from '../components/ui.tsx';

interface AdminCard {
  to: '/admin/settings/general' | '/admin/users' | '/admin/jobs' | '/requests' | '/upload';
  title: string;
  text: string;
  Icon: LucideIcon;
  anyOf: readonly number[];
}

const CARDS: readonly AdminCard[] = [
  {
    to: '/requests',
    title: 'Request queue',
    text: 'Approve, decline and retry what people asked for.',
    Icon: ListMusic,
    anyOf: [Permission.MANAGE_REQUESTS],
  },
  {
    to: '/upload',
    title: 'Upload review',
    text: 'Check matches and import uploaded music.',
    Icon: Upload,
    anyOf: [Permission.MANAGE_UPLOADS],
  },
  {
    to: '/admin/users',
    title: 'Users',
    text: 'Accounts, permissions, quotas and Jellyfin import.',
    Icon: Users,
    anyOf: [Permission.MANAGE_USERS],
  },
  {
    to: '/admin/settings/general',
    title: 'Settings',
    text: 'Sign-in, media server, library, metadata, providers and notifications.',
    Icon: Settings,
    anyOf: [Permission.MANAGE_SETTINGS],
  },
  {
    to: '/admin/jobs',
    title: 'Jobs',
    text: 'Background work: status, errors and retries.',
    Icon: Activity,
    anyOf: [Permission.MANAGE_SETTINGS],
  },
];

export function AdminPage() {
  const { hasPermission } = useAuth();
  const cards = CARDS.filter((card) => hasPermission(card.anyOf, 'or'));
  return (
    <PageFrame title="Admin" subtitle="Manage this server.">
      {cards.length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-muted">
          There is nothing for you to manage here.
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {cards.map(({ to, title, text, Icon }) => (
            <Link key={to} to={to} className="block">
              <Card className="flex h-full items-start gap-4 p-5 transition-colors hover:border-accent">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span>
                  <span className="block font-medium">{title}</span>
                  <span className="mt-0.5 block text-sm text-muted">{text}</span>
                </span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </PageFrame>
  );
}
