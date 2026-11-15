// Firma Viva — cliente do banco próprio. O cliente do Prisma é gerado em ../generated/client
// (separado do cliente do Cenário Gestão) e carregado em tempo de execução (CommonJS).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const generated = require('../generated/client/index.js');

export const Prisma = generated.Prisma;
export const PrismaClient = generated.PrismaClient;

export function createFirmaClient(url) {
  return new PrismaClient({
    ...(url ? { datasources: { db: { url } } } : {}),
    log: ['warn'],
    transactionOptions: { timeout: 30_000, maxWait: 10_000 },
  });
}
