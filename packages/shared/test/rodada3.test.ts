import { describe, expect, it } from 'vitest';
import { audienceAllows } from '../src';

/** Remediação pós-auditoria, Rodada 3 — regras puras (tempo real). As de compras e do CSV saíram com os módulos. */
describe('F1-09 — audiência por tipo de sessão', () => {
  const tablet = (perms: string[]) => ({
    kind: 'DEVICE' as const,
    userId: 'u1',
    permissions: new Set(perms),
  });
  const web = (perms: string[]) => ({ ...tablet(perms), kind: 'WEB' as const });
  it('tablet com permissão gerencial NÃO recebe o evento dessa audiência; o painel recebe', () => {
    expect(audienceAllows('permission:financeiro.ver', tablet(['financeiro.ver']))).toBe(false);
    expect(audienceAllows('permission:financeiro.ver', web(['financeiro.ver']))).toBe(true);
    expect(
      audienceAllows('permission:ocorrencias.gerenciar', tablet(['ocorrencias.gerenciar'])),
    ).toBe(false);
  });
  it('tablet continua recebendo o próprio e as audiências operacionais', () => {
    expect(audienceAllows('user:u1', tablet([]))).toBe(true);
    expect(audienceAllows('user:u2', tablet([]))).toBe(false);
    expect(audienceAllows('permission:producao.executar', tablet(['producao.executar']))).toBe(
      true,
    );
    expect(audienceAllows('all', tablet([]))).toBe(true);
  });
});
