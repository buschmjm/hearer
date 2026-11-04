import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeToggle } from '../src/components/ThemeToggle.tsx';
import { resolveTheme } from '../src/lib/theme-context.ts';
import { ThemeProvider } from '../src/lib/theme.tsx';

const setup = () =>
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );

describe('theme toggle', () => {
  it('offers light, system and dark, defaulting to system', () => {
    setup();
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Light' })).not.toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('light'); // jsdom: no dark preference
  });

  it('applies and persists the chosen theme', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('hearer.theme')).toBe('dark');
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('hearer.theme')).toBe('light');
  });

  it('forgets the stored choice when going back to system', async () => {
    const user = userEvent.setup();
    localStorage.setItem('hearer.theme', 'dark');
    setup();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(localStorage.getItem('hearer.theme')).toBeNull();
  });

  it('resolves system against the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});
