import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Multi-empresa — cliente do banco com empresa definida (Row-Level Security).
 *
 * Cada operação roda numa transação que começa trocando o papel para `cenario_app` (sem
 * superusuário, sem BYPASSRLS) e gravando `app.company_id` / `app.bypass_rls`. Ver
 * apps/api/src/core/tenant.ts e a migration 20270427000000_multi_empresa_etapa3.
 */
/** Papel do banco com RLS aplicada (criado pela migration da etapa 3). */
export const APP_DB_ROLE = 'cenario_app';

export type Scope = () => {
  companyId: number | null;
  bypass: boolean;
  /**
   * Mantém o papel da conexão (dono das tabelas) em vez de trocar para `cenario_app`. Só para
   * ferramentas de manutenção e testes que aplicam/revertem migrations dentro da transação.
   */
  owner?: boolean;
};

const MODEL_METHODS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);
const RAW_METHODS = new Set(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe']);

function prelude(client: PrismaClient | Prisma.TransactionClient, scope: Scope) {
  const { companyId, bypass, owner } = scope();
  return client.$executeRaw`SELECT set_config('role', ${owner ? 'none' : APP_DB_ROLE}, true),
    set_config('app.company_id', ${companyId === null ? '' : String(companyId)}, true),
    set_config('app.bypass_rls', ${bypass ? 'on' : 'off'}, true)`;
}

export function scopedPrismaClient(base: PrismaClient, scope: Scope): PrismaClient {
  const single = <T>(op: Prisma.PrismaPromise<T>): Promise<T> =>
    base.$transaction([prelude(base, scope), op]).then((r) => r[1] as T);

  const delegates = new Map<string | symbol, unknown>();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (arg: unknown, options?: Parameters<PrismaClient['$transaction']>[1]) => {
          if (typeof arg !== 'function') {
            throw new Error('Transação em lote não é suportada pelo cliente da empresa.');
          }
          const fn = arg as (tx: Prisma.TransactionClient) => Promise<unknown>;
          return target.$transaction(async (tx) => {
            await prelude(tx, scope);
            return fn(tx);
          }, options);
        };
      }
      if (typeof prop === 'string' && RAW_METHODS.has(prop)) {
        const raw = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
        return (...args: unknown[]) =>
          single(raw.apply(target, args) as Prisma.PrismaPromise<unknown>);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (
        typeof prop === 'string' &&
        !prop.startsWith('$') &&
        !prop.startsWith('_') &&
        value &&
        typeof value === 'object' &&
        'findMany' in value
      ) {
        let d = delegates.get(prop);
        if (!d) {
          const delegate = value as Record<string, (...a: unknown[]) => unknown>;
          d = new Proxy(delegate, {
            get(dt, method) {
              const fn = Reflect.get(dt, method) as unknown;
              if (typeof method !== 'string' || !MODEL_METHODS.has(method)) return fn;
              return (...args: unknown[]) =>
                single((fn as (...a: unknown[]) => Prisma.PrismaPromise<unknown>).apply(dt, args));
            },
          });
          delegates.set(prop, d);
        }
        return d;
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/**
 * Garante o papel `cenario_app` e os privilégios dele (idempotente). Roda na conexão do dono
 * (a mesma das migrations) ao iniciar a API: os backups são gerados com `--no-privileges`, então
 * uma restauração traz as tabelas e as políticas mas não os GRANTs — sem isto a API ficaria sem
 * acesso a nada depois de restaurar.
 */
export async function ensureAppDbRole(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_ROLE}') THEN
    BEGIN
      CREATE ROLE ${APP_DB_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN duplicate_object THEN NULL; -- outra instância criou ao mesmo tempo
    END;
  END IF;
  IF NOT pg_has_role(current_user, '${APP_DB_ROLE}', 'MEMBER') THEN
    EXECUTE format('GRANT ${APP_DB_ROLE} TO %I', current_user);
  END IF;
END
$$`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_DB_ROLE}`);
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_DB_ROLE}`,
  );
  await owner.$executeRawUnsafe(
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP_DB_ROLE}`,
  );
  await owner.$executeRawUnsafe(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_DB_ROLE}`,
  );
}
