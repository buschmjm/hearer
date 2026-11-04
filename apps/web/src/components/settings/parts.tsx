import { REDACTED_SECRET } from '@hearer/shared';
import type { ReactNode } from 'react';
import { getIn } from '../../lib/path.ts';
import { SecretField, Switch } from '../controls.tsx';
import { Alert, Button, Field, Spinner } from '../ui.tsx';
import type { SectionDraft } from './useSectionDraft.ts';

/** Sticky bar under a settings form: dirty state, cancel and save. */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onCancel,
  error,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  error?: string | undefined;
}) {
  return (
    <div
      className={
        dirty
          ? 'sticky bottom-[4.5rem] z-10 mt-6 rounded-2xl border border-accent/50 bg-surface/95 p-3 shadow-card backdrop-blur lg:bottom-4'
          : 'mt-6 rounded-2xl border border-line bg-surface p-3'
      }
    >
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted" aria-live="polite">
          {dirty ? 'You have unsaved changes.' : 'No unsaved changes.'}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={!dirty || saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!dirty} loading={saving} onClick={onSave}>
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Spinner or load error until the section arrived, then the form. */
export function DraftGate({
  draft,
  children,
}: {
  draft: Pick<SectionDraft, 'loading' | 'loadError'>;
  children: ReactNode;
}) {
  if (draft.loading) return <Spinner />;
  if (draft.loadError) return <Alert>{draft.loadError}</Alert>;
  return <>{children}</>;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** Bound inputs: each reads a dotted path from the draft and writes it back. */
export function DraftText({
  draft,
  path,
  label,
  hint,
  type = 'text',
  placeholder,
}: {
  draft: SectionDraft;
  path: string;
  label: string;
  hint?: ReactNode;
  type?: 'text' | 'url';
  placeholder?: string;
}) {
  return (
    <Field
      label={label}
      hint={hint}
      type={type}
      spellCheck={false}
      autoCapitalize="none"
      placeholder={placeholder}
      value={text(draft.get(path))}
      error={draft.errors[path]}
      onChange={(e) => {
        draft.set(path, e.target.value);
      }}
    />
  );
}

export function DraftNumber({
  draft,
  path,
  label,
  hint,
  min,
  max,
  step,
}: {
  draft: SectionDraft;
  path: string;
  label: string;
  hint?: ReactNode;
  min?: number;
  max?: number;
  step?: number;
}) {
  const current = draft.get(path);
  return (
    <Field
      label={label}
      hint={hint}
      type="number"
      inputMode="decimal"
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      {...(step === undefined ? {} : { step })}
      value={typeof current === 'number' ? String(current) : text(current)}
      error={draft.errors[path]}
      onChange={(e) => {
        draft.set(path, e.target.value === '' ? '' : Number(e.target.value));
      }}
    />
  );
}

export function DraftSwitch({
  draft,
  path,
  label,
  hint,
  warning,
}: {
  draft: SectionDraft;
  path: string;
  label: string;
  hint?: ReactNode;
  warning?: ReactNode;
}) {
  return (
    <Switch
      label={label}
      hint={hint}
      warning={warning}
      checked={draft.get(path) === true}
      onChange={(next) => {
        draft.set(path, next);
      }}
    />
  );
}

export function DraftSecret({
  draft,
  path,
  label,
  hint,
}: {
  draft: SectionDraft;
  path: string;
  label: string;
  hint?: ReactNode;
}) {
  return (
    <SecretField
      label={label}
      hint={hint}
      value={text(draft.get(path))}
      stored={getIn(draft.saved, path.split('.')) === REDACTED_SECRET}
      error={draft.errors[path]}
      onChange={(next) => {
        draft.set(path, next);
      }}
    />
  );
}
