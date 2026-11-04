import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../api/auth.ts';
import { errorMessage } from '../api/client.ts';
import { setupStatusQuery } from '../api/setup.ts';
import { AuthShell } from '../components/AuthShell.tsx';
import { Alert, Card, Spinner } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { AdminStep } from '../components/wizard/AdminStep.tsx';
import { GeneralStep } from '../components/wizard/GeneralStep.tsx';
import { LibraryStep } from '../components/wizard/LibraryStep.tsx';
import { MediaServerStep } from '../components/wizard/MediaServerStep.tsx';
import { ReviewStep } from '../components/wizard/ReviewStep.tsx';
import { SetupSignIn } from '../components/wizard/SetupSignIn.tsx';

import { SETUP_STEPS } from '../lib/setupSteps.ts';
const STORAGE_KEY = 'hearer.setup.step';

function readSavedStep(): number {
  try {
    const n = Number(sessionStorage.getItem(STORAGE_KEY));
    return Number.isInteger(n) && n >= 0 && n < SETUP_STEPS.length ? n : 0;
  } catch {
    return 0;
  }
}

function Stepper({ current }: { current: number }) {
  return (
    <nav aria-label="Setup progress" className="mb-5">
      <p className="mb-3 text-center text-sm text-muted sm:hidden">
        Step {current + 1} of {SETUP_STEPS.length}:{' '}
        <span className="text-fg">{SETUP_STEPS[current]}</span>
      </p>
      <ol className="flex items-center justify-center gap-1.5 sm:gap-2">
        {SETUP_STEPS.map((label, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={label}
              aria-current={active ? 'step' : undefined}
              className="flex items-center gap-1.5 sm:gap-2"
            >
              <span
                className={cx(
                  'grid size-7 place-items-center rounded-full text-xs font-semibold',
                  done && 'bg-accent text-accent-fg',
                  active && 'bg-accent-soft text-accent ring-2 ring-accent',
                  !done && !active && 'bg-surface-2 text-muted',
                )}
              >
                {done ? <Check className="size-4" aria-label="completed" /> : index + 1}
              </span>
              <span
                className={cx(
                  'hidden text-sm whitespace-nowrap sm:inline',
                  active ? 'font-medium' : 'text-muted',
                )}
              >
                {label}
              </span>
              {index < SETUP_STEPS.length - 1 && (
                <span className="h-px w-3 bg-line sm:w-6" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function SetupPage() {
  const router = useRouter();
  const status = useQuery(setupStatusQuery());
  const { me, isLoading: authLoading } = useAuth();
  const [saved, setSaved] = useState(readSavedStep);

  if (status.isPending || authLoading) {
    return (
      <AuthShell title="Hearer">
        <Spinner />
      </AuthShell>
    );
  }
  if (status.isError) {
    return (
      <AuthShell title="Hearer">
        <Alert>{errorMessage(status.error)}</Alert>
      </AuthShell>
    );
  }

  const { hasAdmin } = status.data;
  // The status decides where we are: no admin means step 1; otherwise never earlier than step 2.
  const step = hasAdmin ? Math.min(Math.max(saved, 1), SETUP_STEPS.length - 1) : 0;
  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(next, SETUP_STEPS.length - 1));
    setSaved(clamped);
    try {
      sessionStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // Not persisted; resuming then falls back to the server's view of progress.
    }
  };
  const finish = () => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    router.history.push('/');
  };

  return (
    <AuthShell title="Hearer" wide>
      <Card className="p-5 sm:p-8">
        <h1 className="sr-only">Set up Hearer</h1>
        <Stepper current={step} />
        {hasAdmin && !me ? (
          <SetupSignIn />
        ) : (
          <>
            {step === 0 && (
              <AdminStep
                onNext={() => {
                  go(1);
                }}
              />
            )}
            {step === 1 && (
              <GeneralStep
                onNext={() => {
                  go(2);
                }}
              />
            )}
            {step === 2 && (
              <MediaServerStep
                onBack={() => {
                  go(1);
                }}
                onNext={() => {
                  go(3);
                }}
              />
            )}
            {step === 3 && (
              <LibraryStep
                onBack={() => {
                  go(2);
                }}
                onNext={() => {
                  go(4);
                }}
              />
            )}
            {step === 4 && (
              <ReviewStep
                onBack={() => {
                  go(3);
                }}
                onDone={finish}
              />
            )}
          </>
        )}
      </Card>
    </AuthShell>
  );
}
