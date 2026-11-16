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

  it('cada unicidade marcada "por empresa" existe hoje como única no sistema inteiro', () => {
    const problemas: string[] = [];
    for (const [name, entry] of Object.entries(TENANCY)) {
      for (const campo of entry.perCompanyUnique ?? []) {
        const f = byName.get(name)!.fields.find((x) => x.name === campo);
        if (!f) problemas.push(`${name}.${campo} não existe`);
        else if (!f.isUnique) problemas.push(`${name}.${campo} não é única hoje`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it('toda numeração automática (pedido nº, OS nº…) está marcada para recomeçar por empresa', () => {
    const faltando: string[] = [];
    for (const m of models) {
      for (const f of m.fields) {
        const auto = (f.default as { name?: string } | undefined)?.name === 'autoincrement';
        if (!auto || f.isId) continue;
        const entry = TENANCY[m.name]!;
        // A sequência da fila de eventos é técnica e continua global.
        if (m.name === 'DomainEvent' && f.name === 'seq') continue;
        if (!entry.perCompanyUnique?.includes(f.name)) faltando.push(`${m.name}.${f.name}`);
      }
    }
    expect(faltando).toEqual([]);
  });

  it('o retrato do mapa (para acompanhar as próximas etapas)', () => {
    const conta = (c: string) => Object.values(TENANCY).filter((e) => e.class === c).length;
    expect({
      total: models.length,
      empresa: conta('empresa'),
      acesso: conta('acesso'),
      sistema: conta('sistema'),
      raiz: conta('empresa-raiz'),
    }).toEqual({ total: 129, empresa: 119, acesso: 6, sistema: 3, raiz: 1 });
  });
});
