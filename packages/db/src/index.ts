import { Prisma, PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient };
export type * from '@prisma/client';

export type Tx = Prisma.TransactionClient;

export interface CreatePrismaOptions {
  url?: string;
  log?: Prisma.LogLevel[];
}

export function createPrismaClient(options: CreatePrismaOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.url ? { datasources: { db: { url: options.url } } } : {}),
    // Erros são registrados pelo tratador de erros da API (evita log duplicado de conflitos tratados).
    log: options.log ?? ['warn'],
    // Fase 12: operações grandes (publicar a semana com dezenas de OS, painel financeiro) passavam
    // do limite padrão de 5 s da transação interativa e falhavam com erro 500 — limite maior,
    // mantendo a espera por conexão curta.
    transactionOptions: { timeout: 60_000, maxWait: 10_000 },
  });
}

/** Detecta violação de unicidade do PostgreSQL vinda do Prisma. */
export function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (!field) return true;
  const target = (error.meta?.target ?? []) as string[] | string;
  return Array.isArray(target) ? target.includes(field) : String(target).includes(field);
}
