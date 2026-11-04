import type { ReactNode } from 'react';
import { Brand } from './Logo.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { cx } from '../lib/cx.ts';

/** Centered page used by sign-in and the setup wizard. */
export function AuthShell({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col px-4 py-5 sm:py-8">
      <div className="mx-auto flex w-full max-w-5xl justify-end">
        <ThemeToggle />
      </div>
      <main
        className={cx(
          'mx-auto flex w-full flex-1 flex-col justify-center py-6',
          wide ? 'max-w-2xl' : 'max-w-md',
        )}
      >
        <div className="mb-7 flex justify-center">
          <Brand title={title} className="[&_svg]:size-11 [&_span]:text-2xl" />
        </div>
        {children}
      </main>
    </div>
  );
}
