import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronUp, KeyRound, LogOut, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Permission } from '@hearer/shared';
import { authMethodsQuery, useAuth, useSignOut } from '../api/auth.ts';
import { requestCountsQuery } from '../api/requests.ts';
import { visibleNav, type NavItem } from '../lib/nav.ts';
import { Brand } from './Logo.tsx';
import { ToastProvider } from './Toast.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { cx } from '../lib/cx.ts';

function useAppTitle(): string {
  const { data } = useQuery(authMethodsQuery());
  const title = data?.appTitle ?? 'Hearer';
  useEffect(() => {
    document.title = title;
  }, [title]);
  return title;
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[1]] : [name.trim().slice(0, 2)];
  return letters
    .map((part) => part?.[0] ?? '')
    .join('')
    .toUpperCase();
}

const menuItem =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-fg hover:bg-surface-2';

export function UserMenu({ placement }: { placement: 'up' | 'down' }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  const name = user.displayName ?? user.username;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left hover:bg-surface-2"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
          {initials(name)}
        </span>
        <span className="hidden min-w-0 flex-1 lg:block">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted">@{user.username}</span>
        </span>
        <ChevronUp
          className={cx('hidden size-4 text-muted lg:block', open ? '' : 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div
          role="menu"
          className={cx(
            'absolute z-30 w-60 rounded-xl border border-line bg-surface p-1.5 shadow-card',
            placement === 'up' ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2',
          )}
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted">{user.email ?? `@${user.username}`}</p>
          </div>
          <Link
            to="/account"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setOpen(false);
            }}
          >
            <UserRound className="size-4 text-muted" aria-hidden /> Profile
          </Link>
          <Link
            to="/account/api-keys"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setOpen(false);
            }}
          >
            <KeyRound className="size-4 text-muted" aria-hidden /> API keys
          </Link>
          <div className="my-1.5 flex items-center justify-between border-t border-line px-3 pt-2.5 pb-1.5">
            <span className="text-xs text-muted">Theme</span>
            <ThemeToggle />
          </div>
          <button
            type="button"
            role="menuitem"
            className={cx(menuItem, 'text-danger')}
            disabled={signOut.isPending}
            onClick={() => {
              signOut.mutate(undefined, {
                onSettled: () => {
                  setOpen(false);
                  void navigate({ to: '/login', search: {} });
                },
              });
            }}
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** Requests waiting for a decision, for people who can approve them (refreshed every minute). */
function usePendingCount(): number {
  const { hasPermission } = useAuth();
  const { data } = useQuery({
    ...requestCountsQuery(true),
    enabled: hasPermission(Permission.MANAGE_REQUESTS),
    refetchInterval: 60_000,
  });
  return data?.byStatus.PENDING ?? 0;
}

function PendingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden
        className="ml-auto grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-5 text-accent-fg tabular-nums"
      >
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">{` (${String(count)} pending)`}</span>
    </>
  );
}

function SideNavLink({ item, badge = 0 }: { item: NavItem; badge?: number }) {
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === '/' }}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      activeProps={{ className: 'bg-accent-soft !text-accent' }}
    >
      <item.Icon className="size-5" aria-hidden />
      {item.label}
      <PendingBadge count={badge} />
    </Link>
  );
}

function BottomNavLink({ item, badge = 0 }: { item: NavItem; badge?: number }) {
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === '/' }}
      className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium text-muted"
      activeProps={{ className: '!text-accent' }}
    >
      <span className="relative">
        <item.Icon className="size-5" aria-hidden />
        {badge > 0 && (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-2.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-accent-fg tabular-nums"
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      {item.label}
      {badge > 0 && <span className="sr-only">{` (${String(badge)} pending)`}</span>}
    </Link>
  );
}

/** Authenticated shell: sidebar on desktop, top bar plus bottom tabs on phones. */
export function Layout() {
  const { user } = useAuth();
  const title = useAppTitle();
  const items = visibleNav(user?.permissions ?? 0);
  const pending = usePendingCount();

  return (
    <ToastProvider>
      <div className="min-h-dvh lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
        >
          Skip to content
        </a>

        <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface/70 p-4 backdrop-blur lg:flex">
          <Link to="/" className="mb-6 px-2 pt-1" aria-label={`${title} home`}>
            <Brand title={title} />
          </Link>
          <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-1">
            {items.map((item) => (
              <SideNavLink
                key={item.to}
                item={item}
                badge={item.to === '/requests' ? pending : 0}
              />
            ))}
          </nav>
          <UserMenu placement="up" />
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/85 px-4 py-2.5 backdrop-blur lg:hidden">
            <Link to="/" aria-label={`${title} home`}>
              <Brand title={title} />
            </Link>
            <UserMenu placement="down" />
          </header>
          <main
            id="main"
            className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-[calc(6.5rem+env(safe-area-inset-bottom))] lg:px-10 lg:py-10 lg:pb-10"
          >
            <Outlet />
          </main>
        </div>

        <nav
          aria-label="Mobile navigation"
          className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        >
          {items.map((item) => (
            <BottomNavLink
              key={item.to}
              item={item}
              badge={item.to === '/requests' ? pending : 0}
            />
          ))}
        </nav>
      </div>
    </ToastProvider>
  );
}
