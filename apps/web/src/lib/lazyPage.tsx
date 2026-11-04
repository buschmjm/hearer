/* eslint-disable react-refresh/only-export-components -- a helper that builds components, not a component module */
import { lazy, Suspense, type ComponentType } from 'react';

function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="p-6 text-sm text-muted">
      Loading…
    </div>
  );
}

/**
 * A page component loaded on demand (its own bundle chunk) with a loading state. Used for pages
 * most visitors never open, so the initial bundle stays small.
 */
export function lazyPage(load: () => Promise<() => React.JSX.Element>): () => React.JSX.Element;
export function lazyPage<P extends object>(
  load: () => Promise<(props: P) => React.JSX.Element>,
): (props: P) => React.JSX.Element;
export function lazyPage<P extends object>(
  load: () => Promise<(props: P) => React.JSX.Element>,
): (props: P) => React.JSX.Element {
  const Page = lazy<ComponentType<P>>(async () => ({
    default: (await load()) as ComponentType<P>,
  }));
  return function LazyPage(props: P) {
    return (
      <Suspense fallback={<PageLoading />}>
        <Page {...(props as P & React.JSX.IntrinsicAttributes)} />
      </Suspense>
    );
  };
}
