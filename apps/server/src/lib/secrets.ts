import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_PREFIX = 'enc:v1:';
export const SECRET_KEY_FILENAME = 'secret.key';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_SALT = 'hearer/secrets/salt/v1';
const HKDF_INFO = 'hearer/secrets/aes-256-gcm/v1';

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

/** AES-256-GCM encryption of short strings, keyed from arbitrary secret material via HKDF. */
export class SecretBox {
  readonly #key: Buffer;

  constructor(keyMaterial: string | Buffer) {
    if (keyMaterial.length === 0) throw new SecretError('secret key material is empty');
    this.#key = Buffer.from(hkdfSync('sha256', keyMaterial, HKDF_SALT, HKDF_INFO, KEY_BYTES));
  }

  static isEncrypted(value: string): boolean {
    return value.startsWith(SECRET_PREFIX);
  }

  /** Output: `enc:v1:` + base64url(iv | auth tag | ciphertext). A fresh IV is used every call. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher: CipherGCM = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return SECRET_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  /** Throws SecretError if the value is not ours, was tampered with, or the key differs. */
  decrypt(value: string): string {
    if (!SecretBox.isEncrypted(value)) throw new SecretError('value is not an encrypted secret');
    const raw = Buffer.from(value.slice(SECRET_PREFIX.length), 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new SecretError('encrypted secret is truncated');
    const decipher: DecipherGCM = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      raw.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new SecretError('failed to decrypt secret (wrong key or corrupted data)');
    }
  }
}

/**
 * Key material comes from HEARER_SECRET when set, otherwise from `<dataDir>/secret.key`, which is
 * generated (32 random bytes, mode 0600) on first use and reused afterwards.
 */
export function loadSecretKeyMaterial(options: {
  secret?: string | undefined;
  dataDir: string;
}): string {
  if (options.secret) return options.secret;
  const file = join(options.dataDir, SECRET_KEY_FILENAME);
  mkdirSync(options.dataDir, { recursive: true });
  try {
    // 'wx' fails if another process created the file first; then we simply read theirs.
    writeFileSync(file, randomBytes(KEY_BYTES).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  const material = readFileSync(file, 'utf8').trim();
  if (material.length === 0) throw new SecretError(`${file} is empty; delete it to regenerate`);
  return material;
}

export function createSecretBox(options: {
  secret?: string | undefined;
  dataDir: string;
}): SecretBox {
  return new SecretBox(loadSecretKeyMaterial(options));
}
