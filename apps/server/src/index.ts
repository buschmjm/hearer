import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { openDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { createSecretBox } from './lib/secrets.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const database = openDatabase(config.dataDir);
  let app;
  try {
    runMigrations(database.db);
    const secrets = createSecretBox({ secret: config.secret, dataDir: config.dataDir });
    app = await buildApp(config, {
      db: database,
      secrets,
      startJobs: true,
      jobs: { workerId: 'main' },
    });
  } catch (err) {
    database.close();
    throw err;
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      app.log.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    // pino writes to stdout synchronously, so nothing is left buffered once close resolves.
    app.close().then(
      () => {
        database.close();
        process.exit(0);
      },
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        database.close();
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
