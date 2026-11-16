import {
  ALL_PERMISSIONS,
  MODULE_KEYS,
  READINESS_CHECKS,
  RELEASE_BLOCKERS,
  evaluateRelease,
} from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import {
  type Etapa,
  INTERRUPTORES_REMOVIDOS,
  PERMISSOES_REMOVIDAS,
  ROTAS_REMOVIDAS,
  etapasConcluidas,
} from './remocao/catalogo';
import { createTestApp, db, idemKey, loginAdmin, ORIGIN, resetDatabase } from './helpers';
import { day } from './production-helpers';

/**
 * Reformulação por remoção real — S0, GRUPO B (requisitos FUTUROS, etapas S1–S7).
 *
 * Cada teste descreve o comportamento EXIGIDO depois da etapa. Enquanto a etapa não constar em
 * tests/remocao/etapas-concluidas.json, ele roda como `it.fails`: a suíte fica verde e, ao mesmo
 * tempo, PROVA que o requisito ainda não está atendido (se ele passasse sozinho, `it.fails` quebraria
 * — sinal de que o teste é fraco ou de que alguém removeu algo fora da etapa). Ao concluir a etapa, o
 * implementador registra a etapa no JSON e o teste vira obrigatório. Nenhuma funcionalidade foi
 * alterada para estes testes passarem.
 */
const CONCLUIDAS = etapasConcluidas();
const futuro = (etapa: Etapa) => (CONCLUIDAS.has(etapa) ? it : it.fails);

let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());

describe('Remoção real — Grupo B: rotas descontinuadas respondem 404', () => {
  for (const etapa of Object.keys(ROTAS_REMOVIDAS) as Etapa[]) {
    const rotas = ROTAS_REMOVIDAS[etapa];
    if (!rotas.length) continue;
    futuro(etapa)(`${etapa}: ${rotas.length} rota(s) deixam de existir`, async () => {
      const presentes: string[] = [];
      for (const [method, url] of rotas) {
        const r = await app.app.inject({ method, url, headers: { origin: ORIGIN } });
        if (r.statusCode !== 404) presentes.push(`${method} ${url} → ${r.statusCode}`);
      }
      expect(presentes).toEqual([]);
    });
  }
});

describe('Remoção real — Grupo B: permissões e interruptores descontinuados', () => {
  const chaves = new Set<string>(ALL_PERMISSIONS);
  for (const etapa of Object.keys(PERMISSOES_REMOVIDAS) as Etapa[]) {
    const lista = PERMISSOES_REMOVIDAS[etapa];
    if (!lista.length) continue;
    futuro(etapa)(`${etapa}: permissões fora do catálogo (${lista.join(', ')})`, () => {
      expect(lista.filter((p) => chaves.has(p))).toEqual([]);
    });
  }
  for (const etapa of Object.keys(INTERRUPTORES_REMOVIDOS) as Etapa[]) {
    const lista = INTERRUPTORES_REMOVIDOS[etapa];
    if (!lista.length) continue;
    futuro(etapa)(`${etapa}: interruptor(es) inexistente(s): ${lista.join(', ')}`, () => {
      expect(lista.filter((k) => (MODULE_KEYS as readonly string[]).includes(k))).toEqual([]);
    });
  }
});

describe('Remoção real — Grupo B: regras de domínio', () => {
  futuro('S1')('S1: "pronta para entrega" não tem a condição EMBALAGEM', () => {
    expect((READINESS_CHECKS as readonly string[]).includes('EMBALAGEM')).toBe(false);
  });

  const base = {
    osActive: true,
    published: true,
    assigned: true,
    dependenciesDone: true,
    manuallyBlocked: false,
    openIssue: false,
    scheduledAt: null,
    now: new Date(),
  };
  futuro('S2')(
    'S2: material não comprado/recebido NUNCA bloqueia a tarefa (sem bloqueio MATERIAIS)',
    () => {
      expect((RELEASE_BLOCKERS as readonly string[]).includes('MATERIAIS')).toBe(false);
      expect(evaluateRelease(base).blockers).toEqual([]);
    },
  );
  futuro('S5')(
    'S5: peça ainda não recebida NÃO bloqueia a tarefa (chegada é opcional — D1)',
    () => {
      expect((RELEASE_BLOCKERS as readonly string[]).includes('PECA_NAO_RECEBIDA')).toBe(false);
    },
  );
  it('controle: bloqueios legítimos continuam (Grupo A embutido)', () => {
    expect(evaluateRelease({ ...base, dependenciesDone: false }).blockers).toContain(
      'DEPENDENCIAS',
    );
    expect(evaluateRelease({ ...base, assigned: false }).blockers).toContain('SEM_RESPONSAVEL');
    expect(evaluateRelease({ ...base, published: false }).blockers).toContain('NAO_PUBLICADA');
    expect(evaluateRelease({ ...base, manuallyBlocked: true }).blockers).toContain('BLOQUEIO');
  });
});

describe('Remoção real — Grupo B: fluxo da OS no fechamento (D1)', () => {
  beforeEach(async () => resetDatabase());

  futuro('S5')(
    'S5: "Novo serviço" fechado cria a OS imediatamente, sem recebimento da peça',
    async () => {
      const admin = await loginAdmin(app);
      const r = await admin.post(
        '/api/v1/services',
        {
          customer: { mode: 'NOVO', kind: 'PF', name: 'HML-Cliente S0', phone: '(11) 98880-0001' },
          service: {
            contractedService: 'Reforma',
            agreedValueCents: 100000,
            paymentTerms: 'A combinar',
            promisedDate: day(30),
            items: [
              {
                pieceType: 'SOFA',
                description: 'Sofá',
                quantity: 1,
                serviceType: 'REFORMA_COMPLETA',
              },
            ],
          },
        },
        { 'idempotency-key': idemKey() },
      );
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const os = await db().serviceOrder.count({ where: { orderId: r.body.order.id } });
      expect(os).toBe(1);
    },
  );
});
