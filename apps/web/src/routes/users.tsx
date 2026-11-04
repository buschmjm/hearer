import {
  Permission,
  createUserRequestSchema,
  type UpdateUserRequest,
  type UserDto,
} from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Search, Trash2, Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../api/auth.ts';
import { errorMessage } from '../api/client.ts';
import {
  USERS_PAGE_SIZE,
  jellyfinCandidatesQuery,
  useCreateUser,
  useDeleteUser,
  useImportJellyfin,
  useResetPassword,
  useUpdateUser,
  usersQuery,
} from '../api/users.ts';
import { PageFrame, RequirePermission } from '../components/admin/PageFrame.tsx';
import { Badge, Pagination } from '../components/controls.tsx';
import { ConfirmDialog, Dialog } from '../components/Dialog.tsx';
import { PermissionEditor } from '../components/PermissionEditor.tsx';
import { Alert, Button, Card, Field, Spinner } from '../components/ui.tsx';
import { serverFieldErrors, zodErrors } from '../lib/formErrors.ts';
import { canManageUser, grantableBits, permissionSummary } from '../lib/permissionGroups.ts';
import { toast } from '../lib/toast.ts';
import { passwordSchema } from '@hearer/shared';

const initials = (user: UserDto): string =>
  (user.displayName ?? user.username).trim().slice(0, 2).toUpperCase();

const AUTH_LABEL = { local: 'Local', jellyfin: 'Jellyfin', oidc: 'SSO' } as const;

function Avatar({ user }: { user: UserDto }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
      {initials(user)}
    </span>
  );
}

function PermissionChips({ mask }: { mask: number }) {
  const names = permissionSummary(mask);
  if (names.length === 0) return <span className="text-xs text-muted">None</span>;
  const shown = names.slice(0, 3);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((n) => (
        <Badge key={n} tone={n === 'Admin' ? 'accent' : 'neutral'}>
          {n}
        </Badge>
      ))}
      {names.length > shown.length && <Badge>+{names.length - shown.length}</Badge>}
    </span>
  );
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const { user: me } = useAuth();
  const create = useCreateUser();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [permissions, setPermissions] = useState<number | undefined>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  const submit = () => {
    setFormError(undefined);
    const body = {
      username,
      password,
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(permissions === undefined ? {} : { permissions }),
    };
    const parsed = createUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (created) => {
        toast.success(`Created ${created.username}.`);
        onClose();
      },
      onError: (err) => {
        setErrors(serverFieldErrors(err));
        setFormError(errorMessage(err));
      },
    });
  };

  return (
    <Dialog
      wide
      title="Create local user"
      description="They sign in with this username and password."
      onClose={onClose}
      busy={create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={submit}>
            Create user
          </Button>
        </>
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Username"
            autoComplete="off"
            value={username}
            error={errors.username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
          />
          <Field
            label="Display name"
            value={displayName}
            error={errors.displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
            }}
          />
          <Field
            label="Email"
            type="email"
            value={email}
            error={errors.email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
          <Field
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters."
            value={password}
            error={errors.password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Permissions</h3>
          <p className="mb-3 text-xs text-muted">
            {permissions === undefined
              ? 'The default permissions apply. Change a box to set them yourself.'
              : 'Custom permissions.'}
          </p>
          <PermissionEditor
            name="create-permissions"
            value={permissions ?? 0}
            canGrant={grantableBits(me?.permissions ?? 0)}
            onChange={setPermissions}
          />
        </div>
        {formError && <Alert>{formError}</Alert>}
      </form>
    </Dialog>
  );
}

const quotaText = (value: number | null): string => (value === null ? '' : String(value));
const parseQuota = (text: string): number | null => (text.trim() === '' ? null : Number(text));

function EditUserDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const { user: me } = useAuth();
  const update = useUpdateUser();
  const editable = user.authType === 'local';
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [email, setEmail] = useState(user.email ?? '');
  const [permissions, setPermissions] = useState(user.permissions);
  const [quotas, setQuotas] = useState({
    requestQuotaLimit: quotaText(user.requestQuotaLimit),
    requestQuotaDays: quotaText(user.requestQuotaDays),
    uploadQuotaMb: quotaText(user.uploadQuotaMb),
    uploadQuotaDays: quotaText(user.uploadQuotaDays),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const canManage = canManageUser(me?.permissions ?? 0, user.permissions);

  const submit = () => {
    setFormError(undefined);
    const body: UpdateUserRequest = {
      permissions,
      requestQuotaLimit: parseQuota(quotas.requestQuotaLimit),
      requestQuotaDays: parseQuota(quotas.requestQuotaDays),
      uploadQuotaMb: parseQuota(quotas.uploadQuotaMb),
      uploadQuotaDays: parseQuota(quotas.uploadQuotaDays),
      ...(editable ? { displayName: displayName.trim() || null, email: email.trim() || null } : {}),
    };
    update.mutate(
      { id: user.id, body },
      {
        onSuccess: () => {
          toast.success(`Saved ${user.username}.`);
          onClose();
        },
        onError: (err) => {
          setErrors(serverFieldErrors(err));
          setFormError(errorMessage(err));
        },
      },
    );
  };

  const quotaField = (key: keyof typeof quotas, label: string) => (
    <Field
      label={label}
      type="number"
      min={0}
      placeholder="Default"
      value={quotas[key]}
      error={errors[key]}
      onChange={(e) => {
        setQuotas({ ...quotas, [key]: e.target.value });
      }}
    />
  );

  return (
    <Dialog
      wide
      title={`Edit ${user.username}`}
      description={`${AUTH_LABEL[user.authType]} account`}
      onClose={onClose}
      busy={update.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button loading={update.isPending} disabled={!canManage} onClick={submit}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!canManage && (
          <Alert tone="info">
            This account holds permissions you do not, so only an administrator can change it.
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Display name"
            disabled={!editable || !canManage}
            value={displayName}
            error={errors.displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
            }}
          />
          <Field
            label="Email"
            type="email"
            disabled={!editable || !canManage}
            value={email}
            error={errors.email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </div>
        {!editable && (
          <p className="-mt-3 text-xs text-muted">Name and email come from the sign-in provider.</p>
        )}
        <div>
          <h3 className="mb-3 text-sm font-semibold">Permissions</h3>
          <PermissionEditor
            name="edit-permissions"
            value={permissions}
            disabled={!canManage}
            canGrant={grantableBits(me?.permissions ?? 0)}
            onChange={setPermissions}
          />
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">Quotas</h3>
          <p className="mb-3 text-xs text-muted">
            Leave empty to use the defaults from settings. 0 means unlimited.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {quotaField('requestQuotaLimit', 'Requests allowed')}
            {quotaField('requestQuotaDays', 'Request window (days)')}
            {quotaField('uploadQuotaMb', 'Upload allowance (MB)')}
            {quotaField('uploadQuotaDays', 'Upload window (days)')}
          </div>
        </div>
        {formError && <Alert>{formError}</Alert>}
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const reset = useResetPassword();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const submit = () => {
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setError('Use between 8 and 128 characters.');
      return;
    }
    reset.mutate(
      { id: user.id, newPassword: password },
      {
        onSuccess: () => {
          toast.success(`Password reset for ${user.username}. They were signed out everywhere.`);
          onClose();
        },
        onError: (err) => {
          setError(errorMessage(err));
        },
      },
    );
  };
  return (
    <Dialog
      title={`Reset password for ${user.username}`}
      description="They will be signed out everywhere."
      onClose={onClose}
      busy={reset.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={reset.isPending}>
            Cancel
          </Button>
          <Button loading={reset.isPending} onClick={submit}>
            Reset password
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
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          error={error}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(undefined);
          }}
        />
      </form>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const candidates = useQuery(jellyfinCandidatesQuery());
  const run = useImportJellyfin();
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const importable =
    candidates.data?.filter((c) => c.importedUserId === null && !c.isDisabled) ?? [];

  const submit = () => {
    run.mutate(picked, {
      onSuccess: (result) => {
        toast.success(
          `Imported ${String(result.imported.length)} user${result.imported.length === 1 ? '' : 's'}.`,
        );
        onClose();
      },
      onError: (err) => {
        setError(errorMessage(err));
      },
    });
  };

  return (
    <Dialog
      title="Import from Jellyfin"
      description="New accounts get the default permissions, without uploads. Jellyfin administrators do not become administrators here."
      onClose={onClose}
      busy={run.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button loading={run.isPending} disabled={picked.length === 0} onClick={submit}>
            Import {picked.length > 0 ? `${String(picked.length)} selected` : 'selected'}
          </Button>
        </>
      }
    >
      {candidates.isPending ? (
        <Spinner />
      ) : candidates.isError ? (
        <Alert>{errorMessage(candidates.error)}</Alert>
      ) : (
        <div className="space-y-3">
          {importable.length > 1 && (
            <button
              type="button"
              className="text-xs font-medium text-accent hover:underline"
              onClick={() => {
                setPicked(picked.length === importable.length ? [] : importable.map((c) => c.id));
              }}
            >
              {picked.length === importable.length ? 'Select none' : 'Select all'}
            </button>
          )}
          <ul className="divide-y divide-line rounded-lg border border-line">
            {candidates.data.map((c) => {
              const blocked = c.importedUserId !== null || c.isDisabled;
              return (
                <li key={c.id}>
                  <label
                    className={`flex min-h-12 items-center gap-3 px-3 py-2 ${blocked ? 'opacity-60' : 'cursor-pointer'}`}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-(--accent)"
                      disabled={blocked}
                      checked={picked.includes(c.id)}
                      onChange={(e) => {
                        setPicked(
                          e.target.checked ? [...picked, c.id] : picked.filter((p) => p !== c.id),
                        );
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                    {c.importedUserId !== null && <Badge tone="success">Already imported</Badge>}
                    {c.isDisabled && <Badge tone="warn">Disabled</Badge>}
                    {c.isAdmin && <Badge>Jellyfin admin</Badge>}
                  </label>
                </li>
              );
            })}
            {candidates.data.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted">
                No users found on the server.
              </li>
            )}
          </ul>
          {error && <Alert>{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

type Modal =
  { kind: 'create' } | { kind: 'import' } | { kind: 'edit' | 'password' | 'delete'; user: UserDto };

const dateText = (iso: string): string => new Date(iso).toLocaleDateString();

function UsersContent() {
  const { user: me } = useAuth();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<Modal>();
  const [deleteError, setDeleteError] = useState<string>();
  const remove = useDeleteUser();
  const list = useQuery(usersQuery(page, q));

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(input.trim());
      setPage(1);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [input]);

  const close = () => {
    setModal(undefined);
  };

  return (
    <PageFrame
      title="Users"
      subtitle="Accounts, permissions and quotas."
      actions={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setModal({ kind: 'import' });
            }}
          >
            <Download className="size-4" aria-hidden /> Import from Jellyfin
          </Button>
          <Button
            onClick={() => {
              setModal({ kind: 'create' });
            }}
          >
            <Plus className="size-4" aria-hidden /> Create user
          </Button>
        </div>
      }
    >
      <div className="relative mb-4">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          type="search"
          aria-label="Search users"
          placeholder="Search by name, username or email"
          value={input}
          className="min-h-11 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-base sm:text-sm"
          onChange={(e) => {
            setInput(e.target.value);
          }}
        />
      </div>

      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert>{errorMessage(list.error)}</Alert>
      ) : list.data.items.length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-muted">No users match.</Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,2.2fr)_6rem_minmax(0,2fr)_6.5rem_auto] gap-4 border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase md:grid">
            <span>User</span>
            <span>Sign-in</span>
            <span>Permissions</span>
            <span>Created</span>
            <span className="w-28 text-right">Actions</span>
          </div>
          <ul className="divide-y divide-line">
            {list.data.items.map((u) => {
              const manageable = canManageUser(me?.permissions ?? 0, u.permissions);
              return (
                <li
                  key={u.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,2.2fr)_6rem_minmax(0,2fr)_6.5rem_auto] md:items-center md:gap-4"
                >
                  <div className="flex min-w-0 items-center gap-3 max-md:col-span-2">
                    <Avatar user={u} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{u.displayName ?? u.username}</p>
                      <p className="truncate text-xs text-muted">
                        @{u.username}
                        {u.email ? ` · ${u.email}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="max-md:col-span-2 max-md:flex max-md:items-center max-md:gap-2">
                    <Badge tone={u.authType === 'local' ? 'neutral' : 'accent'}>
                      {AUTH_LABEL[u.authType]}
                    </Badge>
                    <span className="text-xs text-muted md:hidden">
                      Created {dateText(u.createdAt)}
                    </span>
                  </div>
                  <div className="max-md:col-span-2">
                    <PermissionChips mask={u.permissions} />
                  </div>
                  <span className="hidden text-xs text-muted md:block">
                    {dateText(u.createdAt)}
                  </span>
                  <div className="flex justify-end gap-1 max-md:col-span-2">
                    <Button
                      variant="ghost"
                      className="px-2.5"
                      aria-label={`Edit ${u.username}`}
                      onClick={() => {
                        setModal({ kind: 'edit', user: u });
                      }}
                    >
                      <Pencil className="size-4" aria-hidden />
                    </Button>
                    {u.authType === 'local' && u.id !== me?.id && (
                      <Button
                        variant="ghost"
                        className="px-2.5"
                        aria-label={`Reset password for ${u.username}`}
                        disabled={!manageable}
                        onClick={() => {
                          setModal({ kind: 'password', user: u });
                        }}
                      >
                        <KeyRound className="size-4" aria-hidden />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="px-2.5 hover:text-danger"
                      aria-label={`Delete ${u.username}`}
                      disabled={u.id === me?.id || !manageable}
                      onClick={() => {
                        setDeleteError(undefined);
                        setModal({ kind: 'delete', user: u });
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {list.data && (
        <Pagination
          page={page}
          pageSize={USERS_PAGE_SIZE}
          total={list.data.total}
          onPage={setPage}
        />
      )}

      {modal?.kind === 'create' && <CreateUserDialog onClose={close} />}
      {modal?.kind === 'import' && <ImportDialog onClose={close} />}
      {modal?.kind === 'edit' && <EditUserDialog user={modal.user} onClose={close} />}
      {modal?.kind === 'password' && <ResetPasswordDialog user={modal.user} onClose={close} />}
      {modal?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete user"
          message={
            <>
              Delete <strong>{modal.user.username}</strong>? Their requests and uploads stay, but
              they can no longer sign in here.
            </>
          }
          confirmLabel="Delete user"
          pending={remove.isPending}
          error={deleteError}
          onClose={close}
          onConfirm={() => {
            remove.mutate(modal.user.id, {
              onSuccess: () => {
                toast.success(`Deleted ${modal.user.username}.`);
                close();
              },
              onError: (err) => {
                setDeleteError(errorMessage(err));
              },
            });
          }}
        />
      )}
    </PageFrame>
  );
}

export function UsersPage() {
  return (
    <RequirePermission anyOf={[Permission.MANAGE_USERS]}>
      <UsersContent />
    </RequirePermission>
  );
}
