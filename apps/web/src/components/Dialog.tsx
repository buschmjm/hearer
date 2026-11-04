import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx.ts';
import { Alert, Button } from './ui.tsx';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface DialogProps {
  /** Controlled visibility. Omit it when the parent mounts the dialog only while it is open. */
  open?: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Action row pinned below the scrollable body. */
  footer?: ReactNode;
  wide?: boolean;
  /** Focus this element when the dialog opens; defaults to the first form control. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Blocks Esc / backdrop / close while a request is in flight. */
  busy?: boolean;
  className?: string;
}

/**
 * Modal dialog: role=dialog + aria-modal, labelled by its title and described by its description,
 * focus moves in and is trapped (Tab / Shift+Tab wrap), Esc and the backdrop close it, focus
 * returns to the opener, and the page behind does not scroll. Sheet-like on phones, centered on
 * larger screens.
 */
export function Dialog({
  open = true,
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
  initialFocus,
  busy = false,
  className,
}: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusables = (): HTMLElement[] =>
      panel.current ? Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    const firstControl = panel.current?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]):not([data-dialog-close])',
    );
    (initialFocus?.current ?? firstControl ?? panel.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [open, initialFocus]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-6">
      <div
        aria-hidden
        className="absolute inset-0 bg-black/60"
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          'relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-card sm:rounded-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {description && (
              <div id={descId} className="mt-0.5 text-sm text-muted">
                {description}
              </div>
            )}
          </div>
          <button
            type="button"
            data-dialog-close
            aria-label="Close dialog"
            disabled={busy}
            className="-m-1.5 grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            onClick={onClose}
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3.5 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Confirm a destructive action. Shows the server's refusal inline and stays open. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
  pending,
  error,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  error?: string | undefined;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      busy={pending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div>{message}</div>
        {error && <Alert>{error}</Alert>}
      </div>
    </Dialog>
  );
}
