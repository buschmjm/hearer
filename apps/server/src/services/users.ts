import { type AuthType, type UserDto, Permission } from '@hearer/shared';
import { and, asc, count, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { HttpError } from '../lib/http-error.ts';
import type { SettingsService } from './settings.ts';

export type UserRow = typeof users.$inferSelect;

/** What `request.user` carries: enough to authorize, nothing secret. */
export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  avatar: string | null;
  authType: AuthType;
  permissions: number;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    avatar: row.avatar,
    authType: row.authType,
    permissions: row.permissions,
  };
}

/** Public shape of a user. Never includes the password hash. */
export function toUserDto(row: UserRow): UserDto {
  return {
    ...toAuthUser(row),
    requestQuotaLimit: row.requestQuotaLimit,
    requestQuotaDays: row.requestQuotaDays,
    uploadQuotaMb: row.uploadQuotaMb,
    uploadQuotaDays: row.uploadQuotaDays,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}

export const usernameTaken = (): HttpError =>
  new HttpError(409, 'username_taken', 'That username is already taken');
export const lastAdmin = (): HttpError =>
  new HttpError(409, 'last_admin', 'There must be at least one administrator');

export interface NewLocalUser {
  username: string;
  passwordHash: string;
  email?: string | null | undefined;
  displayName?: string | null | undefined;
  permissions?: number | undefined;
}

export interface UserPatch {
  email?: string | null | undefined;
  displayName?: string | null | undefined;
  permissions?: number | undefined;
  requestQuotaLimit?: number | null | undefined;
  requestQuotaDays?: number | null | undefined;
  uploadQuotaMb?: number | null | undefined;
  uploadQuotaDays?: number | null | undefined;
}

export interface ExternalProfile {
  username: string;
  email?: string | null | undefined;
  displayName?: string | null | undefined;
  avatar?: string | null | undefined;
}

const isAdminBit = sql`(${users.permissions} & ${Permission.ADMIN}) != 0`;
const byLowerUsername = (username: string) =>
  sql`lower(${users.username}) = ${username.toLowerCase()}`;

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** User CRUD. Synchronous (better-sqlite3), so each method is atomic unless noted. */
export class UsersService {
  readonly #db: Db;
  readonly #settings: SettingsService;

  constructor(db: Db, settings: SettingsService) {
    this.#db = db;
    this.#settings = settings;
  }

  get(id: string): UserRow | undefined {
    return this.#db.select().from(users).where(eq(users.id, id)).get();
  }

  /** The account linked to an identity-provider user, if any. */
  getByExternal(authType: Exclude<AuthType, 'local'>, externalId: string): UserRow | undefined {
    return this.#db
      .select()
      .from(users)
      .where(and(eq(users.authType, authType), eq(users.externalId, externalId)))
      .get();
  }

  /** Case-insensitive username lookup. */
  getByUsername(username: string): UserRow | undefined {
    return this.#db.select().from(users).where(byLowerUsername(username)).get();
  }

  hasAnyUser(): boolean {
    return this.#db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
  }

  countAdmins(): number {
    return this.#db.select({ n: count() }).from(users).where(isAdminBit).get()?.n ?? 0;
  }

  hasAdmin(): boolean {
    return this.countAdmins() > 0;
  }

  list(query: { page: number; pageSize: number; q?: string | undefined }): {
    items: UserRow[];
    total: number;
  } {
    let where;
    if (query.q) {
      const pattern = `%${escapeLike(query.q.toLowerCase())}%`;
      const like = (
        column: typeof users.username | typeof users.email | typeof users.displayName,
      ) => sql`lower(${column}) like ${pattern} escape '\\'`;
      where = or(like(users.username), like(users.email), like(users.displayName));
    }
    const total = this.#db.select({ n: count() }).from(users).where(where).get()?.n ?? 0;
    const items = this.#db
      .select()
      .from(users)
      .where(where)
      .orderBy(asc(sql`lower(${users.username})`), asc(users.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();
    return { items, total };
  }

  createLocal(input: NewLocalUser): UserRow {
    return this.#db.transaction(
      (tx) => {
        if (tx.select({ id: users.id }).from(users).where(byLowerUsername(input.username)).get()) {
          throw usernameTaken();
        }
        return tx
          .insert(users)
          .values({
            username: input.username,
            authType: 'local',
            passwordHash: input.passwordHash,
            email: input.email ?? null,
            displayName: input.displayName ?? null,
            permissions: input.permissions ?? this.#settings.get('general').defaultPermissions,
          })
          .returning()
          .get();
      },
      { behavior: 'immediate' },
    );
  }

  /**
   * Create the very first account as an administrator, only if the table is empty. The check and
   * the insert share one write transaction, so concurrent callers (even from other processes)
   * produce exactly one winner. Returns undefined for the losers.
   */
  createFirstAdmin(input: Omit<NewLocalUser, 'permissions'>): UserRow | undefined {
    return this.#db.transaction(
      (tx) => {
        if (tx.select({ id: users.id }).from(users).limit(1).get()) return undefined;
        return tx
          .insert(users)
          .values({
            username: input.username,
            authType: 'local',
            passwordHash: input.passwordHash,
            email: input.email ?? null,
            displayName: input.displayName ?? null,
            permissions: Permission.ADMIN,
          })
          .returning()
          .get();
      },
      { behavior: 'immediate' },
    );
  }

  /** Apply a patch. Refuses to remove ADMIN from the last administrator. */
  update(id: string, patch: UserPatch): UserRow | undefined {
    return this.#db.transaction(
      (tx) => {
        const current = tx.select().from(users).where(eq(users.id, id)).get();
        if (!current) return undefined;
        const set: Partial<typeof users.$inferInsert> = {};
        for (const key of [
          'email',
          'displayName',
          'permissions',
          'requestQuotaLimit',
          'requestQuotaDays',
          'uploadQuotaMb',
          'uploadQuotaDays',
        ] as const) {
          if (patch[key] !== undefined) Object.assign(set, { [key]: patch[key] });
        }
        if (Object.keys(set).length === 0) return current;
        if (
          set.permissions !== undefined &&
          (current.permissions & Permission.ADMIN) !== 0 &&
          (set.permissions & Permission.ADMIN) === 0 &&
          this.#adminCount(tx) <= 1
        ) {
          throw lastAdmin();
        }
        return tx.update(users).set(set).where(eq(users.id, id)).returning().get();
      },
      { behavior: 'immediate' },
    );
  }

  setPasswordHash(id: string, passwordHash: string): boolean {
    const res = this.#db
      .update(users)
      .set({ passwordHash })
      .where(and(eq(users.id, id), eq(users.authType, 'local')))
      .run();
    return res.changes > 0;
  }

  touchLogin(id: string): void {
    this.#db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id)).run();
  }

  /** Delete a user (sessions, keys, requests and uploads cascade). Refuses the last admin. */
  delete(id: string): boolean {
    return this.#db.transaction(
      (tx) => {
        const current = tx.select().from(users).where(eq(users.id, id)).get();
        if (!current) return false;
        if ((current.permissions & Permission.ADMIN) !== 0 && this.#adminCount(tx) <= 1) {
          throw lastAdmin();
        }
        tx.delete(users).where(eq(users.id, id)).run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  /**
   * Find the account for an identity provider user, or create it with the default permissions.
   * Profile fields are refreshed on every login. A taken username gets a numeric suffix.
   * Whether auto-creation is allowed is the caller's decision (check before calling).
   * `options.permissions` overrides `general.defaultPermissions` for a newly created account.
   */
  findOrCreateExternalUser(
    authType: Exclude<AuthType, 'local'>,
    externalId: string,
    profile: ExternalProfile,
    options: { permissions?: number | undefined } = {},
  ): { user: UserRow; created: boolean } {
    return this.#db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(users)
          .where(and(eq(users.authType, authType), eq(users.externalId, externalId)))
          .get();
        if (existing) {
          const refreshed = tx
            .update(users)
            .set({
              ...(profile.email === undefined ? {} : { email: profile.email }),
              ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
              ...(profile.avatar === undefined ? {} : { avatar: profile.avatar }),
            })
            .where(eq(users.id, existing.id))
            .returning()
            .get();
          return { user: refreshed, created: false };
        }
        const base = profile.username.trim() || externalId;
        let username = base;
        for (
          let n = 2;
          tx.select({ id: users.id }).from(users).where(byLowerUsername(username)).get();
          n++
        ) {
          username = `${base}-${n}`;
        }
        const user = tx
          .insert(users)
          .values({
            username,
            authType,
            externalId,
            email: profile.email ?? null,
            displayName: profile.displayName ?? null,
            avatar: profile.avatar ?? null,
            permissions: options.permissions ?? this.#settings.get('general').defaultPermissions,
          })
          .returning()
          .get();
        return { user, created: true };
      },
      { behavior: 'immediate' },
    );
  }

  #adminCount(tx: Pick<Db, 'select'>): number {
    return tx.select({ n: count() }).from(users).where(isAdminBit).get()?.n ?? 0;
  }
}
