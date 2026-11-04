import { SETTINGS_CATALOG } from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  settingsQuery,
  useSaveSettings,
  type SettingsKey,
  type SettingsSection,
} from '../../api/settings.ts';
import { ApiError, errorMessage } from '../../api/client.ts';
import { serverFieldErrors, zodErrors } from '../../lib/formErrors.ts';
import { getIn, sameJson, setIn } from '../../lib/path.ts';
import { toast } from '../../lib/toast.ts';

/**
 * Edit one settings section: load it, keep a draft, validate with the shared zod schema, and
 * save the FULL section (the API replaces the whole section; masked secrets are echoed back).
 */
export function useSectionDraft(key: SettingsKey, options: { quietSuccess?: boolean } = {}) {
  const query = useQuery(settingsQuery(key));
  const mutation = useSaveSettings(key);
  const [edits, setEdits] = useState<SettingsSection | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  const saved = query.data;
  const value: SettingsSection = edits ?? saved ?? {};
  const dirty = edits !== null && saved !== undefined && !sameJson(edits, saved);

  const set = (path: string | readonly string[], next: unknown) => {
    const parts = typeof path === 'string' ? path.split('.') : path;
    setEdits(setIn(value, parts, next));
    const dotted = parts.join('.');
    if (dotted in errors) {
      setErrors(Object.fromEntries(Object.entries(errors).filter(([k]) => k !== dotted)));
    }
  };

  const get = (path: string): unknown => getIn(value, path.split('.'));

  const reset = () => {
    setEdits(null);
    setErrors({});
    setFormError(undefined);
  };

  /** Returns true when the section was saved. */
  const save = async (): Promise<boolean> => {
    setFormError(undefined);
    const parsed = SETTINGS_CATALOG[key].schema.safeParse(value);
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      setFormError('Fix the highlighted fields and try again.');
      return false;
    }
    try {
      await mutation.mutateAsync(value);
      setEdits(null);
      setErrors({});
      if (!options.quietSuccess) toast.success('Settings saved.');
      return true;
    } catch (err) {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      setFormError(
        Object.keys(fields).length > 0 && err instanceof ApiError && err.code === 'validation_error'
          ? 'The server rejected some values. Fix the highlighted fields and try again.'
          : errorMessage(err),
      );
      return false;
    }
  };

  /** Show extra field errors found outside the schema (for example template checks). */
  const addErrors = (extra: Record<string, string>) => {
    setErrors((current) => ({ ...current, ...extra }));
  };

  return {
    addErrors,
    query,
    loading: query.isPending,
    loadError: query.isError ? errorMessage(query.error) : undefined,
    saved,
    value,
    get,
    set,
    dirty,
    errors,
    formError,
    saving: mutation.isPending,
    save,
    reset,
  };
}

export type SectionDraft = ReturnType<typeof useSectionDraft>;
