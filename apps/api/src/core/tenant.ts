import { AsyncLocalStorage } from 'node:async_hooks';
import { scopedPrismaClient, type PrismaClient } from '@cenario/db';

/**
 * Multi-empresa — etapa 3: de qual empresa é o trabalho em andamento.
 *
 * Cada requisição roda dentro de um `TenantStore` (AsyncLocalStorage). A autenticação preenche
 * `companyId` com a empresa do usuário logado; tarefas em segundo plano usam `runAsCompany`.
 *
 * Toda consulta feita pelo cliente "da empresa" (`createCompanyPrisma`) roda numa transação que,
 * antes de qualquer coisa, troca o papel do banco para `cenario_app` (sem privilégio de
 * superusuário e sem BYPASSRLS) e grava `app.company_id`. As políticas de Row-Level Security do
 * Postgres então só deixam ver e gravar linhas dessa empresa — inclusive no SQL direto.
 * Sem empresa definida, nada aparece e nada é gravado (a coluna company_id fica vazia e o banco
 * recusa).
 *
 * O cliente "do sistema" (`createSystemPrisma`) também troca para `cenario_app`, mas liga
 * `app.bypass_rls`: só para o que precisa atravessar empresas (achar a sessão pelo cookie, o
 * usuário pelo e-mail no login, a fila de eventos, os testes). Usá-lo é sempre uma decisão
 * explícita no código.
 */
export interface TenantStore {
  companyId: number | null;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function currentCompanyId(): number | null {
  return tenantStorage.getStore()?.companyId ?? null;
}

/** Empresa obrigatória: sem ela é erro de programação (nunca cair em outra empresa). */
export function requireCompanyId(): number {
  const id = currentCompanyId();
  if (id == null) throw new Error('Operação sem empresa definida.');
  return id;
}

/** Roda `fn` como trabalho da empresa `companyId` (tarefas de fundo, processamento de eventos). */
export function runAsCompany<T>(companyId: number, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ companyId }, fn);
}

/** Cliente da empresa da requisição (ou da tarefa em `runAsCompany`). */
export function createCompanyPrisma(base: PrismaClient): PrismaClient {
  return scopedPrismaClient(base, () => ({ companyId: currentCompanyId(), bypass: false }));
}

/**
 * Cliente do sistema: enxerga todas as empresas. Só para autenticação, fila de eventos,
 * manutenção e testes. Se houver empresa na requisição, ela continua valendo como padrão das
 * linhas novas.
 */
export function createSystemPrisma(base: PrismaClient): PrismaClient {
  return scopedPrismaClient(base, () => ({ companyId: currentCompanyId(), bypass: true }));
}

/** Roda `fn` uma vez para cada empresa ativa (tarefas periódicas). Falha de uma não para as outras. */
export async function forEachCompany(
  system: PrismaClient,
  fn: () => Promise<unknown>,
): Promise<void> {
  const companies = await system.companySettings.findMany({ select: { id: true } });
  const errors: unknown[] = [];
  for (const c of companies) {
    await runAsCompany(c.id, fn).catch((err: unknown) => errors.push(err));
  }
  if (errors.length) throw errors[0];
}
