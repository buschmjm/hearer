import { Link } from '@tanstack/react-router';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { LogoMark } from './Logo.tsx';
import { Button } from './ui.tsx';

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-[70dvh] place-items-center px-4">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">{children}</div>
    </div>
  );
}

export function NotFound() {
  return (
    <Centered>
      <LogoMark className="size-12" />
      <p className="text-5xl font-semibold tracking-tight text-accent">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted">That page does not exist or has moved.</p>
      <Link
        to="/"
        className="mt-2 inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
      >
        Back to home
      </Link>
    </Centered>
  );
}

export function ErrorFallback({ error, reset }: { error: unknown; reset?: () => void }) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return (
    <Centered>
      <LogoMark className="size-12" />
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted">The page hit an unexpected error.</p>
      <pre className="max-w-full overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-left text-xs text-muted">
        {message}
      </pre>
      <div className="mt-1 flex gap-2">
        <Button
          onClick={() => {
            if (reset) reset();
            else window.location.reload();
          }}
        >
          Try again
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            window.location.assign('/');
          }}
        >
          Go home
        </Button>
      </div>
    </Centered>
  );
}

/** Catches render errors anywhere below it (the router has its own boundary per route). */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; failed: boolean }
> {
  override state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ErrorFallback
        error={this.state.error}
        reset={() => {
          this.setState({ error: null, failed: false });
        }}
      />
    );
  }
}
