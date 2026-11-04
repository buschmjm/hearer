import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadSecretKeyMaterial,
  SECRET_PREFIX,
  SecretBox,
  SecretError,
} from '../src/lib/secrets.ts';

describe('SecretBox', () => {
  const box = new SecretBox('a-long-enough-test-secret');

  it('derives stable, label-specific ids that do not expose the key', () => {
    const other = new SecretBox('another-test-secret-value');
    expect(box.deriveId('x')).toBe(box.deriveId('x'));
    expect(box.deriveId('x')).not.toBe(box.deriveId('y'));
    expect(box.deriveId('x')).not.toBe(other.deriveId('x'));
    expect(box.deriveId('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round trips strings including empty and unicode', () => {
    for (const text of ['hunter2', '', 'päss wörd 🎵', 'x'.repeat(5000)]) {
      const enc = box.encrypt(text);
      expect(enc.startsWith(SECRET_PREFIX)).toBe(true);
      expect(box.decrypt(enc)).toBe(text);
    }
  });

  it('uses a fresh IV so equal plaintexts encrypt differently', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('does not leak the plaintext', () => {
    expect(box.encrypt('super-secret-value')).not.toContain('super-secret-value');
  });

  it('detects tampering in the ciphertext, tag and IV', () => {
    const enc = box.encrypt('payload-to-protect');
    const raw = Buffer.from(enc.slice(SECRET_PREFIX.length), 'base64url');
    for (const index of [0, 13, raw.length - 1]) {
      const copy = Buffer.from(raw);
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      expect(() => box.decrypt(SECRET_PREFIX + copy.toString('base64url'))).toThrow(SecretError);
    }
  });

  it('rejects truncated, foreign and unprefixed values', () => {
    expect(() => box.decrypt(SECRET_PREFIX + 'AAAA')).toThrow(/truncated/);
    expect(() => box.decrypt('plain')).toThrow(/not an encrypted secret/);
    expect(SecretBox.isEncrypted('plain')).toBe(false);
  });

  it('fails to decrypt with a different key', () => {
    const other = new SecretBox('another-test-secret!!');
    expect(() => other.decrypt(box.encrypt('x'))).toThrow(SecretError);
  });

  it('refuses empty key material', () => {
    expect(() => new SecretBox('')).toThrow(SecretError);
  });
});

describe('loadSecretKeyMaterial', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hearer-secret-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers HEARER_SECRET and writes no file', () => {
    expect(loadSecretKeyMaterial({ secret: 'from-env-from-env-1', dataDir: dir })).toBe(
      'from-env-from-env-1',
    );
    expect(() => statSync(join(dir, 'secret.key'))).toThrow();
  });

  it('generates secret.key (0600) in a missing data dir and reuses it', () => {
    const dataDir = join(dir, 'new', 'data');
    const first = loadSecretKeyMaterial({ dataDir });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dataDir, 'secret.key')).mode & 0o777).toBe(0o600);
    expect(loadSecretKeyMaterial({ dataDir })).toBe(first);
    // A box built from the reloaded key decrypts what the first one wrote.
    expect(
      new SecretBox(loadSecretKeyMaterial({ dataDir })).decrypt(new SecretBox(first).encrypt('v')),
    ).toBe('v');
  });

  it('tightens loose permissions and keeps the content', () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'secret.key');
    writeFileSync(file, 'existing-key-material\n', { mode: 0o644 });
    expect(loadSecretKeyMaterial({ dataDir: dir })).toBe('existing-key-material');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('existing-key-material\n');
  });

  it('refuses an empty key file instead of silently using it', () => {
    writeFileSync(join(dir, 'secret.key'), '\n', { mode: 0o600 });
    expect(() => loadSecretKeyMaterial({ dataDir: dir })).toThrow(/empty/);
  });
});
