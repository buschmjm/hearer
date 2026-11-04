import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { toast } from '../src/lib/toast.ts';

// Pages are lazy-loaded route chunks, so the first render of a page can take longer than
// Testing Library's 1 s default on a busy CI runner. Give async queries more headroom.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  toast.clear();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

// jsdom has no matchMedia; tests that care about it stub their own.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    }) as unknown as MediaQueryList;
}

// jsdom does not implement scrolling; the router calls it on navigation.
window.scrollTo = () => undefined;
