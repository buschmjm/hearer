import { REDACTED_SECRET } from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import {
  fulfillmentProvidersQuery,
  lidarrOptionsQuery,
  useTestLidarr,
  type FulfillmentProvider,
} from '../../api/settings.ts';
import { asSchema } from '../../lib/schemaForm.ts';
import { Badge, Section, SelectField, Switch } from '../controls.tsx';
import { SchemaForm, type FieldContext } from '../SchemaForm.tsx';
import { Alert, Button, Field } from '../ui.tsx';
import { DraftGate, SaveBar } from './parts.tsx';
import { useSectionDraft, type SectionDraft } from './useSectionDraft.ts';

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The part of a dotted error map under `block.` */
function blockErrors(errors: Record<string, string>, block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(errors)) {
    if (key.startsWith(`${block}.`)) out[key.slice(block.length + 1)] = message;
  }
  return out;
}

/** A dropdown fed by Lidarr, falling back to a plain input while its options are unavailable. */
function OptionField({
  ctx,
  options,
  loading,
  unavailable,
  numeric,
}: {
  ctx: FieldContext;
  options: { value: string | number; label: string }[] | undefined;
  loading: boolean;
  unavailable: string | undefined;
  numeric: boolean;
}) {
  const current: string | number | undefined =
    typeof ctx.value === 'string' || typeof ctx.value === 'number' ? ctx.value : undefined;
  if (options) {
    const known = options.some((o) => String(o.value) === String(current));
    const all =
      known || current === '' || current === 0 || current === undefined
        ? options
        : [{ value: String(current), label: `Current value (${String(current)})` }, ...options];
    return (
      <SelectField
        label={ctx.label}
        error={ctx.error}
        value={current === undefined || current === 0 ? '' : String(current)}
        placeholder={loading ? 'Loading…' : 'Choose…'}
        options={all}
        onChange={(e) => {
          const raw = e.target.value;
          ctx.onChange(numeric ? (raw === '' ? 0 : Number(raw)) : raw);
        }}
      />
    );
  }
  return (
    <Field
      label={ctx.label}
      error={ctx.error}
      type={numeric ? 'number' : 'text'}
      min={numeric ? 0 : undefined}
      hint={unavailable ?? 'Save the URL and API key to pick from a list.'}
      value={current === undefined ? '' : String(current)}
      onChange={(e) => {
        ctx.onChange(
          numeric ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value,
        );
      }}
    />
  );
}

function ProviderCard({ provider, draft }: { provider: FulfillmentProvider; draft: SectionDraft }) {
  const block = provider.settingsPath.split('.')[1] ?? provider.id;
  const schema = asSchema(provider.configSchema);
  const config = asRecord(draft.get(block));
  const saved = asRecord(draft.saved?.[block]);
  const isLidarr = provider.id === 'lidarr';
  const hasSavedConnection =
    isLidarr &&
    typeof saved.url === 'string' &&
    saved.url !== '' &&
    saved.apiKey === REDACTED_SECRET;
  const options = useQuery(lidarrOptionsQuery(hasSavedConnection));
  const test = useTestLidarr();
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const enabled = config.enabled === true;
  const reason = options.isError ? errorMessage(options.error) : undefined;

  const profileOptions = (list: { id: number; name: string }[] | undefined) =>
    list?.map((item) => ({ value: item.id, label: item.name }));

  const overrides: Record<string, (ctx: FieldContext) => React.ReactNode> = isLidarr
    ? {
        qualityProfileId: (ctx) => (
          <OptionField
            ctx={ctx}
            numeric
            loading={options.isFetching}
            unavailable={reason}
            options={profileOptions(options.data?.qualityProfiles)}
          />
        ),
        metadataProfileId: (ctx) => (
          <OptionField
            ctx={ctx}
            numeric
            loading={options.isFetching}
            unavailable={reason}
            options={profileOptions(options.data?.metadataProfiles)}
          />
        ),
        rootFolder: (ctx) => (
          <OptionField
            ctx={ctx}
            numeric={false}
            loading={options.isFetching}
            unavailable={reason}
            options={options.data?.rootFolders.map((f) => ({ value: f.path, label: f.path }))}
          />
        ),
      }
    : {};

  const runTest = () => {
    setResult(undefined);
    test.mutate(config, {
      onSuccess: (r) => {
        setResult({
          ok: r.ok,
          text: r.ok
            ? `Connected${r.version ? ` (Lidarr ${r.version})` : ''}.`
            : (r.message ?? 'Connection failed.'),
        });
      },
      onError: (err) => {
        setResult({ ok: false, text: errorMessage(err) });
      },
    });
  };

  const supported = (['track', 'album', 'artist'] as const).filter((t) => provider.supports[t]);

  return (
    <Section
      title={provider.label}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          Handles {supported.map((t) => `${t}s`).join(', ')}
          {enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
        </span>
      }
    >
      <Switch
        label={`Use ${provider.label}`}
        checked={enabled}
        onChange={(next) => {
          draft.set(`${block}.enabled`, next);
        }}
      />
      {Object.keys(asSchema(provider.configSchema).properties ?? {}).some(
        (p) => p !== 'enabled',
      ) && (
        <SchemaForm
          schema={schema}
          value={config}
          saved={saved}
          hide={['enabled']}
          errors={blockErrors(draft.errors, block)}
          overrides={overrides}
          onChange={(next) => {
            draft.set(block, next);
          }}
        />
      )}
      {isLidarr && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" loading={test.isPending} onClick={runTest}>
              Test connection
            </Button>
            {hasSavedConnection && options.isError && (
              <Button
                variant="ghost"
                onClick={() => {
                  void options.refetch();
                }}
              >
                Reload choices
              </Button>
            )}
          </div>
          {result &&
            (result.ok ? (
              <Alert tone="success">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-4" aria-hidden /> {result.text}
                </span>
              </Alert>
            ) : (
              <Alert>{result.text}</Alert>
            ))}
        </div>
      )}
    </Section>
  );
}

export function FulfillmentTab() {
  const draft = useSectionDraft('fulfillment');
  const providers = useQuery(fulfillmentProvidersQuery());
  return (
    <DraftGate draft={draft}>
      {providers.isPending ? (
        <Alert tone="info">Loading providers…</Alert>
      ) : providers.isError ? (
        <Alert>{errorMessage(providers.error)}</Alert>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted">
            Approved requests go to the first enabled provider that can handle them, falling back to
            Manual (someone uploads the music).
          </p>
          {providers.data.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} draft={draft} />
          ))}
          <SaveBar
            dirty={draft.dirty}
            saving={draft.saving}
            error={draft.formError}
            onSave={() => void draft.save()}
            onCancel={draft.reset}
          />
        </div>
      )}
    </DraftGate>
  );
}
