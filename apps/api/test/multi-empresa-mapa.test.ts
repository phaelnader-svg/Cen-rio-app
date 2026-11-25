import { Prisma, TENANCY } from '@cenario/db';
import { describe, expect, it } from 'vitest';

/**
 * Multi-empresa — etapa 1. Confere que o mapa de tabelas (`packages/db/src/tenancy.ts`) cobre o
 * banco inteiro e continua coerente com o schema. Um model novo sem classificação quebra este
 * teste: alguém precisa decidir se ele guarda dados de uma empresa.
 */
const models = Prisma.dmmf.datamodel.models;
const byName = new Map(models.map((m) => [m.name, m]));

describe('Multi-empresa: mapa das tabelas', () => {
  it('todo model do banco está classificado, e nada no mapa sobra', () => {
    const semClasse = models.map((m) => m.name).filter((n) => !TENANCY[n]);
    const sobrando = Object.keys(TENANCY).filter((n) => !byName.has(n));
    expect(semClasse, 'models sem classificação em tenancy.ts').toEqual([]);
    expect(sobrando, 'itens de tenancy.ts sem model correspondente').toEqual([]);
  });

  it('existe exatamente uma tabela-raiz de empresa', () => {
    const raiz = Object.entries(TENANCY).filter(([, e]) => e.class === 'empresa-raiz');
    expect(raiz.map(([n]) => n)).toEqual(['CompanySettings']);
  });

  it('tabelas de sistema não apontam para dados de empresa', () => {
    const problemas: string[] = [];
    for (const [name, entry] of Object.entries(TENANCY)) {
      if (entry.class !== 'sistema') continue;
      for (const f of byName.get(name)!.fields) {
        // Só a ponta que guarda a chave estrangeira; listas de volta (ex.: OAuthClient.grants) não contam.
        if (f.kind !== 'object' || !f.relationFromFields?.length) continue;
        const alvo = TENANCY[f.type]?.class;
        if (alvo === 'empresa' || alvo === 'acesso')
          problemas.push(`${name}.${f.name} → ${f.type}`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it('cada unicidade marcada "por empresa" é única junto com a empresa (e não sozinha)', () => {
    const problemas: string[] = [];
    for (const [name, entry] of Object.entries(TENANCY)) {
      const m = byName.get(name)!;
      for (const campo of entry.perCompanyUnique ?? []) {
        const f = m.fields.find((x) => x.name === campo);
        if (!f) problemas.push(`${name}.${campo} não existe`);
        else if (f.isUnique) problemas.push(`${name}.${campo} ainda é única no sistema inteiro`);
        else if (!m.uniqueFields.some((u) => u.join() === `companyId,${campo}`))
          problemas.push(`${name}: falta @@unique([companyId, ${campo}])`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it('toda tabela de empresa e de acesso tem companyId; as de sistema não têm', () => {
    const problemas: string[] = [];
    for (const [name, entry] of Object.entries(TENANCY)) {
      const tem = byName.get(name)!.fields.some((f) => f.name === 'companyId');
      const deve = entry.class === 'empresa' || entry.class === 'acesso';
      if (tem !== deve)
        problemas.push(`${name} (${entry.class}): companyId ${tem ? 'sobrando' : 'faltando'}`);
    }
    expect(problemas).toEqual([]);
  });

  it('nenhuma numeração automática global sobrou (pedido nº, OS nº… são por empresa)', () => {
    const problemas: string[] = [];
    for (const m of models) {
      for (const f of m.fields) {
        const def = (f.default as { name?: string } | undefined)?.name;
        // A sequência da fila de eventos é técnica e continua global.
        if (def === 'autoincrement' && !f.isId && !(m.name === 'DomainEvent' && f.name === 'seq'))
          problemas.push(`${m.name}.${f.name} ainda usa sequência global`);
        if (
          f.name === 'number' &&
          def === 'dbgenerated' &&
          !TENANCY[m.name]!.perCompanyUnique?.includes('number')
        )
          problemas.push(`${m.name}.number sem unicidade por empresa`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it('o retrato do mapa (para acompanhar as próximas etapas)', () => {
    const conta = (c: string) => Object.values(TENANCY).filter((e) => e.class === c).length;
    expect({
      total: models.length,
      empresa: conta('empresa'),
      acesso: conta('acesso'),
      sistema: conta('sistema'),
      raiz: conta('empresa-raiz'),
      // Rodada 2: + feedback_reports (empresa), system_notices e status_samples (sistema).
      // 2026-11-18: + expense_categories (empresa).
      // 2026-11-18 (ajustes): + reworks e manual_revenues (empresa).
      // 2026-11-25 (LGPD): + privacy_requests (empresa).
      // 2026-11-25 (app instalado): + push_subscriptions (empresa) e push_keys (sistema).
    }).toEqual({ total: 179, empresa: 164, acesso: 8, sistema: 6, raiz: 1 });
  });
});
