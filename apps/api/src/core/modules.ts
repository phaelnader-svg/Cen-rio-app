import {
  ERROR_CODES,
  MODULES,
  resolveModules,
  type ModuleKey,
  type ModuleState,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import { AppError } from '../lib/errors';

/**
 * Reformulação, Fase 0 — leitura central dos interruptores de funcionalidade. Todo ponto do
 * servidor que liga/desliga um comportamento passa por aqui (nunca lê a tabela direto), para que
 * "ausente = padrão" e "ainda não configurável = padrão" valham do mesmo jeito em todo lugar.
 * Sem cache: a tabela tem no máximo uma linha por funcionalidade e a leitura é por chave primária;
 * assim a mudança vale na hora para todas as instâncias.
 */
export async function moduleState(db: Tx | PrismaClient): Promise<ModuleState> {
  return resolveModules(await db.moduleSetting.findMany({ select: { key: true, enabled: true } }));
}

export async function moduleEnabled(db: Tx | PrismaClient, key: ModuleKey): Promise<boolean> {
  return (await moduleState(db))[key];
}

export const moduleDisabledError = (key: ModuleKey) =>
  new AppError(
    409,
    ERROR_CODES.MODULE_DISABLED,
    `${MODULES[key].label}: funcionalidade desativada nas configurações da empresa.`,
    { module: key },
  );

/** Recusa explícita (409 MODULE_DISABLED) quando a funcionalidade está desligada. */
export async function assertModuleEnabled(db: Tx | PrismaClient, key: ModuleKey) {
  if (!(await moduleEnabled(db, key))) throw moduleDisabledError(key);
}
