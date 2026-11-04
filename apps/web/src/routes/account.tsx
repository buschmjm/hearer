import {
  changePasswordRequestSchema,
  updateProfileRequestSchema,
  type ApiKeyDto,
  type UserNotifyPrefs,
} from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { KeyRound, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  apiKeysQuery,
  useChangePassword,
  useCreateApiKey,
  useDeleteApiKey,
  useUpdateProfile,
} from '../api/account.ts';
import { useAuth } from '../api/auth.ts';
import { errorMessage } from '../api/client.ts';
import { useSaveUserNotifications, userNotificationsQuery } from '../api/notifications.ts';
import { PageFrame } from '../components/admin/PageFrame.tsx';
import { Badge, CopyButton, Section, Switch } from '../components/controls.tsx';
import { ConfirmDialog, Dialog } from '../components/Dialog.tsx';
import { EventChecklist } from '../components/settings/NotificationsTab.tsx';
import { Alert, Button, Card, Field, Spinner } from '../components/ui.tsx';
import { serverFieldErrors, zodErrors } from '../lib/formErrors.ts';
import { toast } from '../lib/toast.ts';

const TABS = [
  { to: '/account', label: 'Profile' },
  { to: '/account/notifications', label: 'Notifications' },
  { to: '/account/api-keys', label: 'API keys' },
] as const;

function AccountFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PageFrame title={title}>
      <nav aria-label="Account sections" className="-mt-2 mb-6 flex gap-1 border-b border-line">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: true }}
            className="-mb-px border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted hover:text-fg"
            activeProps={{ className: '!border-accent !text-accent' }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </PageFrame>
  );
}

function ProfileForm() {
  const { user } = useAuth();
  const update = useUpdateProfile();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  if (!user) return null;
  const local = user.authType === 'local';

  const submit = () => {
    setFormError(undefined);
    const body = { displayName: displayName.trim() || null, email: email.trim() || null };
    const parsed = updateProfileRequestSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    update.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Profile saved.');
      },
      onError: (err) => {
        setErrors(serverFieldErrors(err));
        setFormError(errorMessage(err));
      },
    });
  };

  return (
    <Section
      title="Profile"
      description={
        local
          ? undefined
          : 'Your name and email come from your sign-in provider, so they cannot be edited here.'
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Username" value={user.username} disabled readOnly />
        <Field
          label="Display name"
          disabled={!local}
          value={displayName}
          error={errors.displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
          }}
        />
        <Field
          label="Email"
          type="email"
          disabled={!local}
          value={email}
          error={errors.email}
          hint="Used for email notifications if you turn them on."
          onChange={(e) => {
            setEmail(e.target.value);
          }}
        />
        {formError && <Alert>{formError}</Alert>}
        {local && (
          <Button type="submit" loading={update.isPending}>
            Save profile
          </Button>
        )}
      </form>
    </Section>
  );
}

function PasswordForm() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  const submit = () => {
    setFormError(undefined);
    const parsed = changePasswordRequestSchema.safeParse({
      currentPassword: current,
      newPassword: next,
    });
    const found = parsed.success ? {} : zodErrors(parsed.error.issues);
    if (parsed.success && next !== confirm) found.confirm = 'The passwords do not match.';
    setErrors(found);
    if (!parsed.success || Object.keys(found).length > 0) return;
    change.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Password changed. Your other sessions were signed out.');
        setCurrent('');
        setNext('');
        setConfirm('');
      },
      onError: (err) => {
        setFormError(errorMessage(err));
      },
    });
  };

  return (
    <Section title="Change password" description="This signs you out everywhere else.">
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          error={errors.currentPassword}
          onChange={(e) => {
            setCurrent(e.target.value);
          }}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters."
          value={next}
          error={errors.newPassword}
          onChange={(e) => {
            setNext(e.target.value);
          }}
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          error={errors.confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
          }}
        />
        {formError && <Alert>{formError}</Alert>}
        <Button type="submit" loading={change.isPending}>
          Change password
        </Button>
      </form>
    </Section>
  );
}

export function AccountPage() {
  const { user } = useAuth();
  return (
    <AccountFrame title="Account">
      <div className="max-w-2xl space-y-5">
        <ProfileForm />
        {user?.authType === 'local' && <PasswordForm />}
      </div>
    </AccountFrame>
  );
}

// ---- my notifications ----

function NotificationPrefs({
  initial,
}: {
  initial: NonNullable<ReturnType<typeof useNotifData>['data']>;
}) {
  const save = useSaveUserNotifications();
  const [emailOn, setEmailOn] = useState(initial.prefs.email?.enabled ?? false);
  const [emailEvents, setEmailEvents] = useState<string[]>(initial.prefs.email?.events ?? []);
  const [topic, setTopic] = useState(initial.prefs.ntfy?.topic ?? '');
  const [ntfyEvents, setNtfyEvents] = useState<string[]>(initial.prefs.ntfy?.events ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  const submit = () => {
    setFormError(undefined);
    const prefs = {
      ...(initial.email.available || initial.prefs.email
        ? { email: { enabled: emailOn, events: emailEvents } }
        : {}),
      ...(topic.trim() ? { ntfy: { topic: topic.trim(), events: ntfyEvents } } : {}),
    } as UserNotifyPrefs;
    save.mutate(prefs, {
      onSuccess: () => {
        setErrors({});
        toast.success('Notification settings saved.');
      },
      onError: (err) => {
        setErrors(serverFieldErrors(err));
        setFormError(errorMessage(err));
      },
    });
  };

  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-sm text-muted">
        You are only ever told about your own requests and uploads.
      </p>
      <Section title="Email">
        {!initial.email.available && (
          <Alert tone="info">
            {initial.email.reason ?? 'Email notifications are not available.'}
          </Alert>
        )}
        <Switch
          label="Email me"
          hint={
            initial.email.address
              ? `Sent to ${initial.email.address}.`
              : 'Add an email address to your profile first.'
          }
          checked={emailOn}
          disabled={!initial.email.available}
          onChange={setEmailOn}
        />
        {emailOn && (
          <EventChecklist events={initial.events} value={emailEvents} onChange={setEmailEvents} />
        )}
      </Section>
      <Section
        title="ntfy"
        description={`Push notifications through ${initial.ntfy.server}. Treat the topic like a password.`}
      >
        <Field
          label="Your topic"
          spellCheck={false}
          autoCapitalize="none"
          hint="Subscribe to it in the ntfy app. Leave empty to turn this off."
          value={topic}
          error={errors['ntfy.topic']}
          onChange={(e) => {
            setTopic(e.target.value);
          }}
        />
        {topic.trim() !== '' && (
          <EventChecklist events={initial.events} value={ntfyEvents} onChange={setNtfyEvents} />
        )}
      </Section>
      {formError && <Alert>{formError}</Alert>}
      <Button loading={save.isPending} onClick={submit}>
        Save notification settings
      </Button>
    </div>
  );
}

function useNotifData() {
  return useQuery(userNotificationsQuery());
}

export function AccountNotificationsPage() {
  const query = useNotifData();
  return (
    <AccountFrame title="Account">
      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <Alert>{errorMessage(query.error)}</Alert>
      ) : (
        <NotificationPrefs initial={query.data} />
      )}
    </AccountFrame>
  );
}

// ---- API keys ----

function CreateKeyDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateApiKey();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [secret, setSecret] = useState<string>();

  const submit = () => {
    if (name.trim() === '') {
      setError('Give the key a name so you can recognise it later.');
      return;
    }
    create.mutate(name.trim(), {
      onSuccess: (r) => {
        setSecret(r.secret);
      },
      onError: (err) => {
        setError(errorMessage(err));
      },
    });
  };

  if (secret) {
    return (
      <Dialog
        title="Your new API key"
        onClose={onClose}
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <div className="space-y-3">
          <Alert tone="info">Copy it now. For your security it is shown only once.</Alert>
          <code
            data-testid="api-key-secret"
            className="block rounded-lg border border-line bg-surface-2 px-3 py-3 text-sm break-all"
          >
            {secret}
          </code>
          <CopyButton value={secret} label="Copy key" />
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Create API key"
      description="Use it to call the API from scripts: send it as an X-Api-Key header."
      onClose={onClose}
      busy={create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={submit}>
            Create key
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label="Name"
          placeholder="Home automation"
          value={name}
          error={error}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
        />
      </form>
    </Dialog>
  );
}

export function ApiKeysPage() {
  const keys = useQuery(apiKeysQuery());
  const remove = useDeleteApiKey();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ApiKeyDto>();
  const [deleteError, setDeleteError] = useState<string>();

  return (
    <AccountFrame title="Account">
      <div className="max-w-2xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-sm text-muted">
            API keys act as you. Treat them like passwords, and delete any you no longer use.
          </p>
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            <KeyRound className="size-4" aria-hidden /> Create key
          </Button>
        </div>
        {keys.isPending ? (
          <Spinner />
        ) : keys.isError ? (
          <Alert>{errorMessage(keys.error)}</Alert>
        ) : keys.data.length === 0 ? (
          <Card className="px-6 py-12 text-center text-sm text-muted">You have no API keys.</Card>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {keys.data.map((key) => (
                <li key={key.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{key.name}</p>
                    <p className="text-xs text-muted">
                      <code>{key.prefix}…</code> · created{' '}
                      {new Date(key.createdAt).toLocaleDateString()} ·{' '}
                      {key.lastUsedAt
                        ? `used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                        : 'never used'}
                    </p>
                  </div>
                  {key.lastUsedAt === null && <Badge>Unused</Badge>}
                  <Button
                    variant="ghost"
                    className="px-2.5 hover:text-danger"
                    aria-label={`Delete key ${key.name}`}
                    onClick={() => {
                      setDeleteError(undefined);
                      setDeleting(key);
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {creating && (
          <CreateKeyDialog
            onClose={() => {
              setCreating(false);
            }}
          />
        )}
        {deleting && (
          <ConfirmDialog
            title="Delete API key"
            message={
              <>
                Delete <strong>{deleting.name}</strong>? Anything using it stops working
                immediately.
              </>
            }
            confirmLabel="Delete key"
            pending={remove.isPending}
            error={deleteError}
            onClose={() => {
              setDeleting(undefined);
            }}
            onConfirm={() => {
              remove.mutate(deleting.id, {
                onSuccess: () => {
                  toast.success('API key deleted.');
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
    </AccountFrame>
  );
}
