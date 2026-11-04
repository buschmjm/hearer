import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTheme, type ThemeMode } from '../lib/theme-context.ts';
import { cx } from '../lib/cx.ts';

const OPTIONS: { mode: ThemeMode; label: string; Icon: LucideIcon }[] = [
  { mode: 'light', label: 'Light', Icon: Sun },
  { mode: 'system', label: 'System', Icon: Monitor },
  { mode: 'dark', label: 'Dark', Icon: Moon },
];

/** Light / system / dark switch. */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cx('inline-flex rounded-lg border border-line bg-surface-2 p-0.5', className)}
    >
      {OPTIONS.map(({ mode: value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          aria-label={label}
          title={label}
          onClick={() => {
            setMode(value);
          }}
          className={cx(
            'grid size-8 place-items-center rounded-md transition-colors',
            mode === value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}
