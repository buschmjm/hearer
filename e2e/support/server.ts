import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './runtime.ts';

const HEALTH_TIMEOUT_MS = 45_000;

export const SERVER_ENTRY = join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js');
export const STATIC_DIR = join(REPO_ROOT, 'apps', 'web', 'dist');

/** Spawn the built server detached, logging (appending) to `logPath`. Returns its pid. */
export function spawnServer(env: Record<string, string>, logPath: string): number {
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    child.unref();
    if (child.pid === undefined) throw new Error('could not start the Hearer server');
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForHealth(url: string, pid: number, logPath: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) throw new Error(`Hearer (pid ${String(pid)}) exited early; see ${logPath}`);
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hearer did not become healthy within ${String(HEALTH_TIMEOUT_MS / 1000)}s`);
}

/** Stop a process: SIGTERM and wait, then SIGKILL after `graceMs`. `hard` skips the grace. */
export async function stopProcess(
  pid: number,
  { hard = false, graceMs = 10_000 } = {},
): Promise<void> {
  if (!isAlive(pid)) return;
  process.kill(pid, hard ? 'SIGKILL' : 'SIGTERM');
  const deadline = Date.now() + (hard ? 5_000 : graceMs);
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  while (isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
}
