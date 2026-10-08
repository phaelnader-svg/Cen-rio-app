import { loadEnv } from './config/env';
import { buildApp } from './app';

async function main() {
  const env = loadEnv();
  const { app, startBackground, close } = await buildApp({ env });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Encerrando com segurança…');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Falha ao encerrar');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) =>
    app.log.error({ err }, 'Promise rejeitada sem tratamento'),
  );

  await startBackground();
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info({ env: env.APP_ENV }, 'API Cenário Gestão pronta');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
