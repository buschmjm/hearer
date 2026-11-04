import { REDACTED_SECRET } from '@hearer/shared';
import { Plus, X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { fieldKind, humanize, propertyEntries, type JsonSchema } from '../lib/schemaForm.ts';
import { Switch, SecretField, SelectField, TextAreaField } from './controls.tsx';
import { Button, Field } from './ui.tsx';

export interface FieldContext {
  name: string;
  label: string;
  value: unknown;
  error: string | undefined;
  onChange: (next: unknown) => void;
}

export interface SchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  errors?: Record<string, string>;
  /** Values as last saved; secrets that were saved there can be restored after "Replace". */
  saved?: Record<string, unknown>;
  /** Properties to leave out (the caller renders them itself). */
  hide?: readonly string[];
  /** Replace the control for one property (e.g. a dropdown fed by another API call). */
  overrides?: Record<string, (ctx: FieldContext) => ReactNode>;
  disabled?: boolean;
}

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

function KeyValueEditor({
  label,
  hint,
  value,
  onChange,
  error,
}: {
  label: string;
  hint?: string | undefined;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  error?: string | undefined;
}) {
  const id = useId();
  const rows = Object.entries(value);
  const rename = (index: number, key: string, val: string) => {
    onChange(Object.fromEntries(rows.map((row, i) => (i === index ? [key, val] : row))));
  };
  return (
    <div>
      <p id={id} className="mb-1.5 text-sm font-medium">
        {label}
      </p>
      <div role="group" aria-labelledby={id} className="space-y-2">
        {rows.map(([key, val], index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              aria-label={`${label} name ${String(index + 1)}`}
              placeholder="Name"
              value={key}
              spellCheck={false}
              className="min-h-11 w-2/5 min-w-0 rounded-lg border border-line bg-surface-2 px-3 text-base sm:text-sm"
              onChange={(e) => {
                rename(index, e.target.value, val);
              }}
            />
            <input
              aria-label={`${label} value ${String(index + 1)}`}
              placeholder="Value"
              value={val}
              spellCheck={false}
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-base sm:text-sm"
              onChange={(e) => {
                rename(index, key, e.target.value);
              }}
            />
            <Button
              variant="ghost"
              aria-label={`Remove ${label} ${String(index + 1)}`}
              onClick={() => {
                onChange(Object.fromEntries(rows.filter((_, i) => i !== index)));
              }}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          onClick={() => {
            onChange({ ...value, '': '' });
          }}
          disabled={'' in value}
        >
          <Plus className="size-4" aria-hidden /> Add
        </Button>
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function MultiSelect({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  options: readonly unknown[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const text = String(option);
          return (
            <label
              key={text}
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm has-checked:border-accent"
            >
              <input
                type="checkbox"
                className="size-4 accent-(--accent)"
                checked={value.includes(text)}
                onChange={(e) => {
                  onChange(e.target.checked ? [...value, text] : value.filter((v) => v !== text));
                }}
              />
              {text}
            </label>
          );
        })}
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </fieldset>
  );
}

/**
 * Renders a form from a JSON Schema: booleans as switches, numbers, enums as selects, strings,
 * URLs, secrets (masked round trip, see SecretField), string lists, string maps and enum arrays.
 * Controlled: the caller owns the values and the error map (keyed by property name).
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  errors = {},
  saved,
  hide = [],
  overrides = {},
  disabled = false,
}: SchemaFormProps) {
  const required = new Set(schema.required ?? []);
  const set = (name: string, next: unknown) => {
    onChange({ ...value, [name]: next });
  };

  return (
    <div className="space-y-4">
      {propertyEntries(schema)
        .filter(([name]) => !hide.includes(name))
        .map(([name, prop]) => {
          const label = prop.title ?? humanize(name);
          const hint = prop.description;
          const error = errors[name];
          const current = value[name];
          const override = overrides[name];
          if (override) {
            return (
              <div key={name}>
                {override({
                  name,
                  label,
                  value: current,
                  error,
                  onChange: (next) => {
                    set(name, next);
                  },
                })}
              </div>
            );
          }
          switch (fieldKind(prop)) {
            case 'boolean':
              return (
                <Switch
                  key={name}
                  label={label}
                  hint={hint}
                  checked={current === true}
                  disabled={disabled}
                  onChange={(next) => {
                    set(name, next);
                  }}
                />
              );
            case 'secret':
              return (
                <SecretField
                  key={name}
                  label={label}
                  hint={hint}
                  error={error}
                  value={asString(current)}
                  stored={saved?.[name] === REDACTED_SECRET}
                  disabled={disabled}
                  onChange={(next) => {
                    set(name, next);
                  }}
                />
              );
            case 'number':
              return (
                <Field
                  key={name}
                  label={label}
                  hint={hint}
                  error={error}
                  type="number"
                  inputMode="numeric"
                  disabled={disabled}
                  {...(prop.minimum === undefined ? {} : { min: prop.minimum })}
                  {...(prop.maximum !== undefined && prop.maximum < 1e12
                    ? { max: prop.maximum }
                    : {})}
                  value={typeof current === 'number' ? String(current) : asString(current)}
                  onChange={(e) => {
                    set(name, e.target.value === '' ? '' : Number(e.target.value));
                  }}
                />
              );
            case 'enum':
              return (
                <SelectField
                  key={name}
                  label={label}
                  hint={hint}
                  error={error}
                  disabled={disabled}
                  value={asString(current)}
                  options={(prop.enum ?? []).map((option) => ({
                    value: String(option),
                    label: humanize(String(option)),
                  }))}
                  onChange={(e) => {
                    set(name, e.target.value);
                  }}
                />
              );
            case 'string':
            case 'url':
              return (
                <Field
                  key={name}
                  label={required.has(name) ? `${label} *` : label}
                  hint={hint}
                  error={error}
                  type={fieldKind(prop) === 'url' ? 'url' : 'text'}
                  spellCheck={false}
                  autoCapitalize="none"
                  disabled={disabled}
                  value={asString(current)}
                  onChange={(e) => {
                    set(name, e.target.value);
                  }}
                />
              );
            case 'list':
              return (
                <TextAreaField
                  key={name}
                  label={label}
                  hint={hint ?? 'One per line.'}
                  error={error}
                  disabled={disabled}
                  value={Array.isArray(current) ? current.map(String).join('\n') : ''}
                  onChange={(e) => {
                    set(name, e.target.value.split('\n'));
                  }}
                />
              );
            case 'multiEnum':
              return (
                <MultiSelect
                  key={name}
                  label={label}
                  hint={hint}
                  options={prop.items?.enum ?? []}
                  value={Array.isArray(current) ? current.map(String) : []}
                  onChange={(next) => {
                    set(name, next);
                  }}
                />
              );
            case 'map':
              return (
                <KeyValueEditor
                  key={name}
                  label={label}
                  hint={hint}
                  error={error}
                  value={
                    typeof current === 'object' && current !== null && !Array.isArray(current)
                      ? Object.fromEntries(
                          Object.entries(current).map(([k, v]) => [k, asString(v)]),
                        )
                      : {}
                  }
                  onChange={(next) => {
                    set(name, next);
                  }}
                />
              );
            case 'unsupported':
              return (
                <p key={name} className="text-xs text-muted">
                  {label}: this field type is not editable here.
                </p>
              );
          }
        })}
    </div>
  );
}
