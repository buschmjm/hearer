import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const checkSchema = z.object({ status: z.enum(['ok', 'error']), message: z.string().optional() });

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  /** Named dependency checks (database, library, ...). Empty until those exist. */
  checks: z.record(z.string(), checkSchema),
});

export type HealthCheck = z.infer<typeof checkSchema>;

export interface HealthDeps {
  version: string;
  /** Extra checks, e.g. the DB ping added in a later batch. */
  checks?: Record<string, () => Promise<HealthCheck> | HealthCheck>;
}

export function healthRoutes(deps: HealthDeps): FastifyPluginCallbackZod {
  return (app, _options, done) => {
    app.get(
      '/health',
      {
        schema: {
          tags: ['system'],
          summary: 'Liveness and dependency health',
          response: { 200: healthResponseSchema },
        },
      },
      async () => {
        const checks: Record<string, HealthCheck> = {};
        for (const [name, run] of Object.entries(deps.checks ?? {})) {
          try {
            checks[name] = await run();
          } catch (err) {
            checks[name] = {
              status: 'error',
              message: err instanceof Error ? err.message : 'failed',
            };
          }
        }
        const degraded = Object.values(checks).some((c) => c.status === 'error');
        return {
          status: degraded ? ('degraded' as const) : ('ok' as const),
          version: deps.version,
          uptimeSeconds: Math.round(process.uptime() * 100) / 100,
          checks,
        };
      },
    );
    done();
  };
}
