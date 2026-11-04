import {
  authMethodsSchema,
  hasPermission,
  meResponseSchema,
  sessionResponseSchema,
  type AuthMethods,
  type LoginRequest,
  type MeResponse,
  type SessionResponse,
} from '@hearer/shared';
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from './client.ts';

export const meKey = ['auth', 'me'] as const;
export const methodsKey = ['auth', 'methods'] as const;

/** The signed-in user, or null when nobody is. Keeps the CSRF token in sync. */
export const meQuery = () =>
  queryOptions({
    queryKey: meKey,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        const me = await api('/auth/me', { schema: meResponseSchema, redirectOn401: false });
        setCsrfToken(me.csrfToken);
        return me;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw err;
      }
    },
  });

export const authMethodsQuery = () =>
  queryOptions({
    queryKey: methodsKey,
    staleTime: 60_000,
    queryFn: ({ signal }): Promise<AuthMethods> =>
      api('/auth/methods', { schema: authMethodsSchema, signal, redirectOn401: false }),
  });

export function useAuth() {
  const query = useQuery(meQuery());
  const me = query.data ?? null;
  return {
    me,
    user: me?.user ?? null,
    isLoading: query.isPending,
    /** ADMIN passes every check. Always false while signed out. */
    hasPermission: (required: number | readonly number[], type: 'and' | 'or' = 'and') =>
      me ? hasPermission(me.user.permissions, required, { type }) : false,
  };
}

/** After login/first-admin creation: remember the CSRF token and load the full profile. */
export async function adoptSession(qc: QueryClient, session: SessionResponse): Promise<void> {
  setCsrfToken(session.csrfToken);
  await qc.invalidateQueries({ queryKey: meKey });
  await qc.query(meQuery());
}

export function useSignIn(kind: 'local' | 'jellyfin') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (credentials: LoginRequest) => {
      const session = await api(kind === 'local' ? '/auth/login' : '/auth/jellyfin', {
        method: 'POST',
        body: credentials,
        schema: sessionResponseSchema,
        redirectOn401: false,
      });
      await adoptSession(qc, session);
      return session;
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await api('/auth/logout', { method: 'POST', redirectOn401: false });
      } finally {
        // Whatever the server said, this browser is done with the session.
        setCsrfToken(null);
        qc.clear();
        qc.setQueryData(meKey, null);
      }
    },
  });
}
