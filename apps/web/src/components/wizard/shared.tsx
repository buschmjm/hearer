import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { sectionQuery, type SectionValues, type SetupSection } from '../../api/setup.ts';
import { errorMessage } from '../../api/client.ts';
import { Alert, Spinner } from '../ui.tsx';

/** Loads a wizard section, then renders the form with the stored values as its initial state. */
export function SectionLoader({
  section,
  children,
}: {
  section: SetupSection;
  children: (values: SectionValues) => ReactNode;
}) {
  const query = useQuery(sectionQuery(section));
  if (query.isPending) return <Spinner />;
  if (query.isError) return <Alert>{errorMessage(query.error)}</Alert>;
  return <>{children(query.data)}</>;
}

export function StepActions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
      {children}
    </div>
  );
}

export interface StepProps {
  onNext: () => void;
  /** Omitted on the first step the user can return to. */
  onBack?: () => void;
}
