import { ALL_PERMISSIONS } from '@cenario/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { PERMISSOES_MANTIDAS, ROTAS_MANTIDAS } from './remocao/catalogo';
import { createTestApp, ORIGIN } from './helpers';

/**
 * Reformulação por remoção real — S0, GRUPO A (regressão obrigatória durante toda a reformulação).
 * O que o dono decidiu MANTER continua existindo: rotas, permissões e fluxos. O comportamento
 * detalhado de cada item já é coberto pelas suítes existentes (ver matriz de rastreabilidade em
 * docs/REFORMULACAO-REMOCAO-S0-RELATORIO.md); aqui fica a garantia estrutural de que nenhuma etapa de
 * remoção leva junto algo que fica.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());

describe('Remoção real — Grupo A: o que FICA continua existindo', () => {
  it.each(ROTAS_MANTIDAS.map(([m, u]) => [`${m} ${u}`, m, u] as const))(
    'rota mantida: %s (sem sessão → 401/403, nunca 404)',
    async (_nome, metodo, url) => {
      const r = await app.app.inject({ method: metodo, url, headers: { origin: ORIGIN } });
      expect(r.statusCode, r.body).not.toBe(404);
      expect([401, 403]).toContain(r.statusCode);
    },
  );

  it('permissões mantidas continuam no catálogo (entrega direta, devoluções, estoque simples, OS…)', () => {
    const chaves = new Set<string>(ALL_PERMISSIONS);
    for (const p of PERMISSOES_MANTIDAS) expect(chaves.has(p), p).toBe(true);
  });
});
