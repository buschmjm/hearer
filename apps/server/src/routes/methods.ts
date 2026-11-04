import { authMethodsSchema } from '@hearer/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

/**
 * `GET /auth/methods` (public): which sign-in options the login page should offer, and the app
 * title it shows. It reveals nothing beyond what the login page itself would show a visitor.
 */
export const authMethodsRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { settings } = app.hearer;
  app.get(
    '/auth/methods',
    {
      schema: {
        tags: ['auth'],
        summary: 'Enabled sign-in methods and app title (public)',
        response: { 200: authMethodsSchema },
      },
    },
    () => {
      const { appTitle } = settings.get('general');
      const auth = settings.get('auth');
      return {
        appTitle,
        local: auth.localEnabled,
        jellyfin: auth.jellyfinEnabled,
        // Same condition as the OIDC service: enabled and minimally configured.
        oidc: {
          enabled: auth.oidc.enabled && auth.oidc.issuerUrl !== '' && auth.oidc.clientId !== '',
          buttonLabel: auth.oidc.buttonLabel,
        },
      };
    },
  );
  done();
};
