import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

/**
 * argon2id with the OWASP Password Storage Cheat Sheet's first recommended profile:
 * 19 MiB memory, 2 iterations, 1 lane.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** True when the password matches. A malformed hash counts as a mismatch, never an exception. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Whether a stored hash uses weaker parameters than the current ones. */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spend the same time a real verification would, for logins that name an unknown (or
 * non-local) account, so response timing does not reveal which usernames exist.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
}
