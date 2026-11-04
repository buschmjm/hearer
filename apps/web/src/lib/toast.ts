import { useSyncExternalStore } from 'react';

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  items = items.filter((item) => item.id !== id);
  emit();
}

function push(tone: ToastTone, message: string, ms: number): void {
  const id = nextId++;
  items = [...items.slice(-3), { id, tone, message }];
  timers.set(
    id,
    setTimeout(() => {
      dismissToast(id);
    }, ms),
  );
  emit();
}

/** Fire-and-forget notices. Rendered by `<Toaster />`, which each admin page includes. */
export const toast = {
  success: (message: string) => {
    push('success', message, 4000);
  },
  info: (message: string) => {
    push('info', message, 4000);
  },
  error: (message: string) => {
    push('error', message, 8000);
  },
  clear: () => {
    for (const item of items) dismissToast(item.id);
  },
};

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => items,
    () => items,
  );
}
