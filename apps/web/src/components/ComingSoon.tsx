import { Hammer } from 'lucide-react';
import { Card, PageHeader } from './ui.tsx';

/** Placeholder for pages a later batch builds. Replace the route's component, not this file. */
export function ComingSoon({ title, children }: { title: string; children?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
          <Hammer className="size-6" aria-hidden />
        </span>
        <p className="font-medium">Coming soon</p>
        <p className="max-w-sm text-sm text-muted">
          {children ?? `${title} is not available yet. It is on the way.`}
        </p>
      </Card>
    </>
  );
}
