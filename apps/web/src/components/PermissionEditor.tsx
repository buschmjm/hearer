import { ALL_PERMISSIONS, Permission } from '@hearer/shared';
import { Lock } from 'lucide-react';
import { PERMISSION_GROUPS } from '../lib/permissionGroups.ts';
import { cx } from '../lib/cx.ts';

/**
 * Checkbox editor for a permission bitmask, shared by the default-permissions setting and the
 * user editor. Bits outside `canGrant` are disabled (you cannot hand out what you do not hold);
 * with ADMIN on, every other bit is implied and shown checked.
 */
export function PermissionEditor({
  value,
  onChange,
  canGrant = ALL_PERMISSIONS,
  disabled = false,
  groups = 'all',
  name = 'permissions',
}: {
  value: number;
  onChange: (next: number) => void;
  canGrant?: number;
  disabled?: boolean;
  /** `basic` leaves out management and administrator bits (for defaults handed to everyone). */
  groups?: 'all' | 'basic';
  name?: string;
}) {
  const isAdmin = (value & Permission.ADMIN) !== 0;
  const shown = PERMISSION_GROUPS.filter(
    (g) => groups === 'all' || g.id === 'requests' || g.id === 'uploads',
  );
  return (
    <div className="space-y-4">
      {shown.map((group) => (
        <fieldset key={group.id} className="min-w-0">
          <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
            {group.title}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {group.choices.map((choice) => {
              const implied = isAdmin && choice.bit !== Permission.ADMIN;
              const grantable = (canGrant & choice.bit) === choice.bit;
              const checked = implied || (value & choice.bit) === choice.bit;
              const locked = disabled || implied || !grantable;
              return (
                <label
                  key={choice.bit}
                  className={cx(
                    'flex min-h-12 items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 has-checked:border-accent',
                    locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                  )}
                >
                  <input
                    type="checkbox"
                    name={name}
                    value={choice.name}
                    className="mt-0.5 size-4 accent-(--accent)"
                    checked={checked}
                    disabled={locked}
                    onChange={(event) => {
                      onChange(event.target.checked ? value | choice.bit : value & ~choice.bit);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {choice.label}
                      {!grantable && !disabled && (
                        <span
                          title="You cannot grant a permission you do not hold"
                          aria-label="You cannot grant a permission you do not hold"
                        >
                          <Lock className="size-3 text-muted" aria-hidden />
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-muted">{choice.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
