import { buildApp } from './app';
import { loadEnv } from './env';

const env = loadEnv();
const { app } = await buildApp({ env });
await app.listen({ host: env.FIRMA_API_HOST, port: env.FIRMA_API_PORT });
app.log.info(`Firma Viva API em ${env.FIRMA_API_PORT} (jogo: ${env.FIRMA_WEB_URL})`);
