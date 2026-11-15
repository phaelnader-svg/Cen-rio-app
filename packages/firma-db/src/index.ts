import { Prisma, PrismaClient } from '../generated/client/index.js';

export { Prisma, PrismaClient };
export type * from '../generated/client/index.js';
export type Tx = Prisma.TransactionClient;

export function createFirmaClient(url?: string): PrismaClient {
  return new PrismaClient({
    ...(url ? { datasources: { db: { url } } } : {}),
    log: ['warn'],
    transactionOptions: { timeout: 30_000, maxWait: 10_000 },
  });
}
