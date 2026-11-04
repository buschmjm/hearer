import { z } from 'zod';
import { passwordSchema, userDtoSchema, usernameSchema } from './users.ts';

export const loginRequestSchema = z.object({
  // Deliberately loose: login must not reveal the username rules.
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Returned by login and the first-admin call. `csrfToken` goes in `x-csrf-token` on writes. */
export const sessionResponseSchema = z.object({
  user: userDtoSchema,
  permissions: z.array(z.string()),
  csrfToken: z.string(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const meResponseSchema = z.object({
  user: userDtoSchema,
  /** Names of the permission bits held (ADMIN is reported as itself only). */
  permissions: z.array(z.string()),
  /** Null when authenticated with an API key (CSRF does not apply to those). */
  csrfToken: z.string().nullable(),
  authMethod: z.enum(['session', 'apiKey']),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const apiKeyDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** First characters of the key, to tell keys apart. */
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiKeyDto = z.infer<typeof apiKeyDtoSchema>;

export const createApiKeyRequestSchema = z.object({ name: z.string().trim().min(1).max(100) });
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

export const createApiKeyResponseSchema = z.object({
  key: apiKeyDtoSchema,
  /** The full key. Shown exactly once. */
  secret: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

// ---- setup wizard ----

export const dirCheckSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  writable: z.boolean(),
  error: z.string().optional(),
});
export type DirCheck = z.infer<typeof dirCheckSchema>;

export const setupStatusSchema = z.object({
  setupComplete: z.boolean(),
  hasAdmin: z.boolean(),
  /** Per-step completion for the wizard. */
  steps: z.object({ admin: z.boolean(), directories: z.boolean() }),
  /** Directory checks; only reported while setup is incomplete (paths are not public after). */
  directories: z.object({ library: dirCheckSchema, staging: dirCheckSchema }).optional(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const setupAdminRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: z.email().max(254).nullish(),
  displayName: z.string().trim().min(1).max(100).nullish(),
});
export type SetupAdminRequest = z.infer<typeof setupAdminRequestSchema>;
