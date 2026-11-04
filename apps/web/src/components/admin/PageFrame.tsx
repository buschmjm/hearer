import { hasPermission } from '@hearer/shared';
import { Link } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '../../api/auth.ts';
import { Toaster } from '../Toaster.tsx';
import { Card, PageHeader, Spinner } from '../ui.tsx';

/** A page body with the shared header and the toast stack. */
export function PageFrame({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={title} {...(subtitle ? { subtitle } : {})} />
        {actions}
      </div>
      {children}
      <Toaster />
    </>
  );
}

/**
 * Renders its children only for users holding the permission. The API enforces this too; the
 * check keeps people out of pages whose every request would answer 403.
 */
export function RequirePermission({
  anyOf,
  children,
}: {
  anyOf: readonly number[];
  children: ReactNode;
}) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <Spinner />;
  if (!user || !hasPermission(user.permissions, anyOf, { type: 'or' })) {
    return (
      <Card className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
          <ShieldAlert className="size-6" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold">You do not have access to this page</h1>
        <p className="text-sm text-muted">Ask an administrator if you need it.</p>
        <Link
          to="/"
          className="mt-1 inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          Back to home
        </Link>
      </Card>
    );
  }
  return <>{children}</>;
}
