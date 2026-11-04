import type {
  NotificationAgentInfo,
  NotificationEventInfo,
  NotificationTargetDto,
} from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { Bell, Hash, Mail, MessageSquare, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import {
  agentsQuery,
  targetsQuery,
  useDeleteTarget,
  useSaveTarget,
  useTestCandidate,
  useTestTarget,
} from '../../api/notifications.ts';
import { errorMessage } from '../../api/client.ts';
import { serverFieldErrors } from '../../lib/formErrors.ts';
import { asSchema, normalizeConfig, validateAgainstSchema } from '../../lib/schemaForm.ts';
import { toast } from '../../lib/toast.ts';
import { Badge, Switch } from '../controls.tsx';
import { ConfirmDialog, Dialog } from '../Dialog.tsx';
import { SchemaForm } from '../SchemaForm.tsx';
import { Alert, Button, Card, Field, Spinner } from '../ui.tsx';

const AGENT_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  webhook: Webhook,
  discord: MessageSquare,
  slack: Hash,
  ntfy: Bell,
  smtp: Mail,
};

function AgentIcon({ agent }: { agent: string }) {
  const Icon = AGENT_ICONS[agent] ?? Bell;
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
      <Icon className="size-5" aria-hidden />
    </span>
  );
}

export function EventChecklist({
  events,
  value,
  onChange,
  legend = 'Notify me about',
}: {
  events: readonly NotificationEventInfo[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  legend?: string;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {events
          .filter((e) => e.subscribable)
          .map((event) => (
            <label
              key={event.id}
              className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 has-checked:border-accent"
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-(--accent)"
                checked={value.includes(event.id)}
                onChange={(e) => {
                  onChange(
                    e.target.checked ? [...value, event.id] : value.filter((v) => v !== event.id),
                  );
                }}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{event.label}</span>
                <span className="block text-xs text-muted">{event.description}</span>
              </span>
            </label>
          ))}
      </div>
    </fieldset>
  );
}

function TargetDialog({
  target,
  agents,
  events,
  onClose,
}: {
  target: NotificationTargetDto | undefined;
  agents: NotificationAgentInfo[];
  events: NotificationEventInfo[];
  onClose: () => void;
}) {
  const save = useSaveTarget();
  const test = useTestCandidate();
  const firstAgent = agents[0];
  const [agentId, setAgentId] = useState<string>(target?.agent ?? firstAgent?.id ?? '');
  const agent = agents.find((a) => a.id === agentId);
  const [name, setName] = useState(target?.name ?? '');
  const [config, setConfig] = useState<Record<string, unknown>>(
    target ? target.config : { ...(firstAgent?.defaultConfig ?? {}) },
  );
  const [selected, setSelected] = useState<string[]>(target?.events ?? []);
  const [enabled, setEnabled] = useState(target?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [nameError, setNameError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string }>();

  const schema = asSchema(agent?.configSchema);

  const changeAgent = (id: string) => {
    setAgentId(id);
    setConfig({ ...(agents.find((a) => a.id === id)?.defaultConfig ?? {}) });
    setErrors({});
    setTestResult(undefined);
  };

  const validate = (): boolean => {
    const found = validateAgainstSchema(schema, config);
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const runTest = () => {
    setTestResult(undefined);
    setFormError(undefined);
    if (!agent || !validate()) return;
    test.mutate(
      {
        agent: agent.id,
        config: normalizeConfig(schema, config),
        ...(target ? { targetId: target.id } : {}),
      },
      {
        onSuccess: (r) => {
          setTestResult({
            ok: r.ok,
            text: r.ok ? 'Test notification sent.' : (r.message ?? 'The test failed.'),
          });
        },
        onError: (err) => {
          setErrors(serverFieldErrors(err));
          setTestResult({ ok: false, text: errorMessage(err) });
        },
      },
    );
  };

  const submit = () => {
    setFormError(undefined);
    if (!agent) return;
    const nameOk = name.trim() !== '';
    setNameError(nameOk ? undefined : 'Give this target a name.');
    if (!validate() || !nameOk) return;
    save.mutate(
      {
        id: target?.id,
        input: {
          name: name.trim(),
          agent: agent.id,
          config: normalizeConfig(schema, config),
          events: selected as NotificationTargetDto['events'],
          enabled,
        },
      },
      {
        onSuccess: () => {
          toast.success(target ? 'Target updated.' : 'Target added.');
          onClose();
        },
        onError: (err) => {
          setErrors(serverFieldErrors(err));
          setFormError(errorMessage(err));
        },
      },
    );
  };

  return (
    <Dialog
      wide
      title={target ? `Edit ${target.name}` : 'Add notification target'}
      onClose={onClose}
      busy={save.isPending}
      footer={
        <>
          <Button variant="secondary" loading={test.isPending} onClick={runTest}>
            <Send className="size-4" aria-hidden /> Send test
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {target ? 'Save target' : 'Add target'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label="Name"
          value={name}
          error={nameError}
          placeholder="Team channel"
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <div>
          <label htmlFor="target-agent" className="mb-1.5 block text-sm font-medium">
            Type
          </label>
          <select
            id="target-agent"
            value={agentId}
            disabled={target !== undefined}
            className="block min-h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-base disabled:opacity-60 sm:text-sm"
            onChange={(e) => {
              changeAgent(e.target.value);
            }}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          {agent && <p className="mt-1.5 text-xs text-muted">{agent.description}</p>}
        </div>
        {agent && (
          <SchemaForm
            key={agent.id}
            schema={schema}
            value={config}
            errors={errors}
            {...(target ? { saved: target.config } : {})}
            onChange={(next) => {
              setConfig(next);
              setTestResult(undefined);
            }}
          />
        )}
        <EventChecklist
          legend="Send when"
          events={events}
          value={selected}
          onChange={setSelected}
        />
        <Switch label="Enabled" checked={enabled} onChange={setEnabled} />
        {testResult && <Alert tone={testResult.ok ? 'success' : 'error'}>{testResult.text}</Alert>}
        {formError && <Alert>{formError}</Alert>}
      </form>
    </Dialog>
  );
}

function TargetRow({
  target,
  agent,
  events,
  onEdit,
  onDelete,
}: {
  target: NotificationTargetDto;
  agent: NotificationAgentInfo | undefined;
  events: NotificationEventInfo[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const save = useSaveTarget();
  const test = useTestTarget();
  const labels = new Map(events.map((e) => [e.id, e.label]));

  const toggle = (next: boolean) => {
    save.mutate(
      {
        id: target.id,
        input: {
          name: target.name,
          agent: target.agent,
          config: target.config,
          events: target.events,
          enabled: next,
        },
      },
      {
        onSuccess: () => {
          toast.success(next ? `${target.name} enabled.` : `${target.name} disabled.`);
        },
        onError: (err) => {
          toast.error(errorMessage(err));
        },
      },
    );
  };

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <AgentIcon agent={target.agent} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{target.name}</p>
          <p className="text-xs text-muted">{agent?.label ?? target.agent}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only sm:not-sr-only text-muted">Enabled</span>
          <input
            type="checkbox"
            role="switch"
            aria-label={`Enable ${target.name}`}
            className="size-5 accent-(--accent)"
            checked={target.enabled}
            disabled={save.isPending}
            onChange={(e) => {
              toggle(e.target.checked);
            }}
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {target.events.length === 0 ? (
          <Badge tone="warn">No events selected</Badge>
        ) : (
          target.events.map((event) => <Badge key={event}>{labels.get(event) ?? event}</Badge>)
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
        <Button
          variant="secondary"
          loading={test.isPending}
          aria-label={`Send test to ${target.name}`}
          onClick={() => {
            test.mutate(target.id, {
              onSuccess: (r) => {
                if (r.ok) toast.success(`Test sent to ${target.name}.`);
                else toast.error(r.message ?? 'The test failed.');
              },
              onError: (err) => {
                toast.error(errorMessage(err));
              },
            });
          }}
        >
          <Send className="size-4" aria-hidden /> Test
        </Button>
        <Button variant="secondary" aria-label={`Edit ${target.name}`} onClick={onEdit}>
          <Pencil className="size-4" aria-hidden /> Edit
        </Button>
        <Button variant="ghost" aria-label={`Delete ${target.name}`} onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden /> Delete
        </Button>
      </div>
    </Card>
  );
}

export function NotificationsTab() {
  const agents = useQuery(agentsQuery());
  const targets = useQuery(targetsQuery());
  const remove = useDeleteTarget();
  const [editing, setEditing] = useState<NotificationTargetDto | 'new'>();
  const [deleting, setDeleting] = useState<NotificationTargetDto>();
  const [deleteError, setDeleteError] = useState<string>();

  if (agents.isPending || targets.isPending) return <Spinner />;
  if (agents.isError || targets.isError) {
    return <Alert>{errorMessage(agents.error ?? targets.error)}</Alert>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">
          Send alerts about requests and uploads to a chat channel, a webhook, ntfy or email. People
          can also opt in to their own notifications from their profile.
        </p>
        <Button
          onClick={() => {
            setEditing('new');
          }}
        >
          <Plus className="size-4" aria-hidden /> Add target
        </Button>
      </div>

      {targets.data.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <p className="font-medium">No notification targets yet</p>
          <p className="mt-1 text-sm text-muted">
            Add one to hear about new requests as they happen.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {targets.data.map((target) => (
            <TargetRow
              key={target.id}
              target={target}
              agent={agents.data.agents.find((a) => a.id === target.agent)}
              events={agents.data.events}
              onEdit={() => {
                setEditing(target);
              }}
              onDelete={() => {
                setDeleteError(undefined);
                setDeleting(target);
              }}
            />
          ))}
        </div>
      )}

      {editing && (
        <TargetDialog
          key={editing === 'new' ? 'new' : editing.id}
          target={editing === 'new' ? undefined : editing}
          agents={agents.data.agents}
          events={agents.data.events}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete target"
          message={
            <>
              Delete <strong>{deleting.name}</strong>? Notifications stop going there.
            </>
          }
          confirmLabel="Delete"
          pending={remove.isPending}
          error={deleteError}
          onClose={() => {
            setDeleting(undefined);
          }}
          onConfirm={() => {
            remove.mutate(deleting.id, {
              onSuccess: () => {
                toast.success('Target deleted.');
                setDeleting(undefined);
              },
              onError: (err) => {
                setDeleteError(errorMessage(err));
              },
            });
          }}
        />
      )}
    </div>
  );
}
