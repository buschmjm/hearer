import { z } from 'zod';
import { AUTH_TYPES } from '../enums.ts';
import { isValidPermissionMask } from '../permissions.ts';

/** Usernames: 3-64 chars, start alphanumeric, then letters, digits and `._@+-`. */
export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@+-]*$/, 'letters, digits and . _ @ + - only');

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** Passwords are never trimmed or normalised. */
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const permissionMaskSchema = z
  .number()
  .int()
  .refine(isValidPermissionMask, 'unknown permission bits');

const quotaInt = z.number().int().min(0).max(1_000_000_000);

/** A user as the API exposes it. Never carries the password hash. */
export const userDtoSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  avatar: z.string().nullable(),
  authType: z.enum(AUTH_TYPES),
  permissions: z.number().int(),
  /** Per-user quota overrides; null means "use the general default". */
  requestQuotaLimit: z.number().int().nullable(),
  requestQuotaDays: z.number().int().nullable(),
  uploadQuotaMb: z.number().int().nullable(),
  uploadQuotaDays: z.number().int().nullable(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const MAX_PAGE_SIZE = 100;

export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  /** Matches username, email and display name (case-insensitive substring). */
  q: z.string().trim().max(100).optional(),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

export const userListResponseSchema = z.object({
  items: z.array(userDtoSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type UserListResponse = z.infer<typeof userListResponseSchema>;

export const createUserRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: z.email().max(254).nullish(),
  displayName: z.string().trim().min(1).max(100).nullish(),
  /** Defaults to the `general.defaultPermissions` setting. */
  permissions: permissionMaskSchema.optional(),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    email: z.email().max(254).nullable(),
    displayName: z.string().trim().min(1).max(100).nullable(),
    permissions: permissionMaskSchema,
    requestQuotaLimit: quotaInt.nullable(),
    requestQuotaDays: quotaInt.min(1).nullable(),
    uploadQuotaMb: quotaInt.nullable(),
    uploadQuotaDays: quotaInt.min(1).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const resetPasswordRequestSchema = z.object({ newPassword: passwordSchema });
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
