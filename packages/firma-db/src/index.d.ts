import { Prisma, PrismaClient } from '../generated/client/index.js';

export { Prisma, PrismaClient };
export type * from '../generated/client/index.js';
export type Tx = Prisma.TransactionClient;
export declare function createFirmaClient(url?: string): PrismaClient;
