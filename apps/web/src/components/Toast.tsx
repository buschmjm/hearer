import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from '../lib/cx.ts';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  message?: string;
}

interface ToastItem extends ToastInput {
  id: number;
  tone: ToastTone;
}

interface ToastApi {
  push: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_STYLES: Record<ToastTone, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-accent',
};
const TONE_ICONS = { success: CheckCircle2, error: AlertCircle, info: Info } as const;

const TOAST_MS = 6000;
const MAX_TOASTS = 4;

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const Icon = TONE_ICONS[toast.tone];
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, TOAST_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [toast.id, onDismiss]);
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-card"
    >
      <Icon className={cx('mt-0.5 size-5 shrink-0', TONE_STYLES[toast.tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium wrap-break-word">{toast.title}</p>
        {toast.message && <p className="mt-0.5 text-sm text-muted">{toast.message}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => {
          onDismiss(toast.id);
        }}
        className="-m-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** A tiny notification system: `useToast().push({ tone, title, message })`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);
  const push = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((list) => [...list, { ...toast, id, tone: toast.tone ?? 'info' }].slice(-MAX_TOASTS));
  }, []);
  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 mx-auto flex w-full max-w-sm flex-col gap-2 px-4 lg:right-6 lg:bottom-6 lg:left-auto lg:mx-0 lg:px-0"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const SILENT: ToastApi = { push: () => undefined };

/** Outside a provider (a bare component test) toasts are dropped instead of throwing. */
// eslint-disable-next-line react-refresh/only-export-components -- hook lives beside its provider
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? SILENT;
}
