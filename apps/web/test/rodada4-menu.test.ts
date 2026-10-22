/**
 * Remediação pós-auditoria, Rodada 4 — F10-01: menu do painel em seis áreas (Início, Serviços,
 * Produção, Compras, Financeiro, Administração).
 *
 * Prova pela estrutura real do menu (components/admin/nav.ts) e pela mesma regra de montagem da
 * barra lateral (components/admin/shell.tsx): filtro por permissão, ordenação por área e um
 * cabeçalho por área (exceto "Início", cuja entrada é o próprio link "Início"). Os cabeçalhos são
 * verificados separadamente dos links — "Financeiro" e "Compras" também são nomes de links.
 * A parte da API do item "Recebimento de materiais" está em
 * apps/api/test/rodada4-travas-estruturais.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_PERMISSIONS, isPermission } from '@cenario/shared';
import { describe, expect, it } from 'vitest';
import { NAV, NAV_GROUPS, navGroupOf } from '../components/admin/nav';

type Entry = { kind: 'header' | 'link'; text: string; href?: string };

/** Mesma montagem de shell.tsx: filtra por permissão, ordena por área e põe os cabeçalhos. */
function sidebar(perms: readonly string[]): Entry[] {
  const set = new Set(perms);
  const items = NAV.filter((i) => !i.anyOf || i.anyOf.some((p) => set.has(p)))
    .map((i, n) => ({ ...i, group: navGroupOf(i.href), n }))
    .sort((a, b) => NAV_GROUPS.indexOf(a.group) - NAV_GROUPS.indexOf(b.group) || a.n - b.n);
  const out: Entry[] = [];
  items.forEach((item, idx) => {
    const header = idx === 0 || items[idx - 1]!.group !== item.group;
    if (header && item.group !== 'Início') out.push({ kind: 'header', text: item.group });
    out.push({ kind: 'link', text: item.label, href: item.href });
  });
  return out;
}
const headers = (e: Entry[]) => e.filter((x) => x.kind === 'header').map((x) => x.text);
const links = (e: Entry[]) => e.filter((x) => x.kind === 'link').map((x) => x.text);

/** Área e permissões esperadas de cada item (trava: mudar exige atualizar aqui). */
const EXPECTED: Record<string, { group: string; anyOf?: string[] }> = {
  '/painel': { group: 'Início' },
  '/painel/servicos/novo': { group: 'Serviços', anyOf: ['pedidos.gerenciar'] },
  '/painel/atencao': { group: 'Início', anyOf: ['ocorrencias.ver', 'ocorrencias.gerenciar'] },
  '/painel/funcionarios': { group: 'Administração', anyOf: ['funcionarios.ver'] },
  '/painel/funcoes': { group: 'Administração', anyOf: ['funcoes.ver'] },
  '/painel/dispositivos': { group: 'Administração', anyOf: ['dispositivos.ver', 'sessoes.ver'] },
  '/painel/clientes': { group: 'Serviços', anyOf: ['clientes.ver'] },
  '/painel/pedidos': { group: 'Serviços', anyOf: ['pedidos.ver'] },
  '/painel/retiradas': { group: 'Serviços', anyOf: ['retiradas.ver'] },
  '/painel/roteiro': { group: 'Serviços', anyOf: ['entregas.ver', 'retiradas.ver'] },
  '/painel/recebimentos': { group: 'Serviços', anyOf: ['recebimentos.registrar', 'pedidos.ver'] },
  '/painel/os': { group: 'Serviços', anyOf: ['os.ver'] },
  '/painel/medicoes': {
    group: 'Produção',
    anyOf: ['medicoes.gerenciar', 'materiais.ver', 'materiais.aprovar'],
  },
  '/painel/planejamento': {
    group: 'Produção',
    anyOf: ['medicoes.gerenciar', 'materiais.ver', 'materiais.aprovar'],
  },
  '/painel/producao/a-planejar': {
    group: 'Produção',
    anyOf: ['producao.ver', 'producao.planejar'],
  },
  '/painel/producao/planejamento': { group: 'Produção', anyOf: ['producao.planejar'] },
  '/painel/producao': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/ajuda': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/reprogramacao': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/competencias': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/producao/modelos': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/compras': {
    group: 'Compras',
    anyOf: ['compras.ver', 'compras.gerenciar', 'compras.aprovar'],
  },
  '/painel/fornecedores': { group: 'Compras', anyOf: ['compras.ver', 'compras.gerenciar'] },
  // Sem filtro de propósito: o recebimento vale para qualquer funcionário (API ANY_EMPLOYEE).
  '/painel/recebimento-materiais': { group: 'Compras' },
  '/painel/estoque': {
    group: 'Compras',
    anyOf: ['estoque.ver', 'estoque.gerenciar', 'compras.ver'],
  },
  '/painel/prontidao': {
    group: 'Compras',
    anyOf: ['os.ver', 'estoque.ver', 'compras.ver', 'materiais.ver'],
  },
  '/painel/materiais': {
    group: 'Compras',
    anyOf: ['materiais.ver', 'materiais.aprovar', 'compras.ver'],
  },
  '/painel/qualidade': { group: 'Serviços', anyOf: ['qualidade.gerenciar'] },
  '/painel/entregas': { group: 'Serviços', anyOf: ['entregas.ver', 'entregas.gerenciar'] },
  '/painel/devolucoes': { group: 'Serviços', anyOf: ['devolucoes.gerenciar'] },
  '/painel/financeiro': { group: 'Financeiro', anyOf: ['financeiro.ver'] },
  '/painel/presenca': { group: 'Produção', anyOf: ['presenca.ver', 'presenca.gerenciar'] },
  '/painel/empresa': { group: 'Administração', anyOf: ['empresa.ver'] },
  '/painel/auditoria': { group: 'Administração', anyOf: ['auditoria.ver'] },
  '/painel/sincronizacao': { group: 'Administração', anyOf: ['sincronizacao.diagnosticar'] },
};

describe('F10-01 — menu em seis áreas', () => {
  it('as seis áreas, na ordem: Início, Serviços, Produção, Compras, Financeiro, Administração', () => {
    expect([...NAV_GROUPS]).toEqual([
      'Início',
      'Serviços',
      'Produção',
      'Compras',
      'Financeiro',
      'Administração',
    ]);
  });

  it('a barra lateral usa exatamente esta montagem (filtro, ordenação e cabeçalhos)', () => {
    const shell = readFileSync(resolve(__dirname, '../components/admin/shell.tsx'), 'utf8');
    expect(shell).toContain('NAV.filter((i) => !i.anyOf || i.anyOf.some((p) => perms.has(p)))');
    expect(shell).toContain('.map((i, n) => ({ ...i, group: navGroupOf(i.href), n }))');
    expect(shell).toContain(
      '.sort((a, b) => NAV_GROUPS.indexOf(a.group) - NAV_GROUPS.indexOf(b.group) || a.n - b.n)',
    );
    expect(shell).toContain('const header = idx === 0 || items[idx - 1]!.group !== item.group;');
    expect(shell).toContain("{header && item.group !== 'Início' && (");
  });

  it('gestor (todas as permissões): cinco cabeçalhos de área e "Início" como primeiro link', () => {
    const e = sidebar(ALL_PERMISSIONS);
    expect(headers(e)).toEqual(['Serviços', 'Produção', 'Compras', 'Financeiro', 'Administração']);
    expect(e[0]).toEqual({ kind: 'link', text: 'Início', href: '/painel' });
    expect(e[1]).toEqual({ kind: 'link', text: 'Central de atenção', href: '/painel/atencao' });
    // Cabeçalho ≠ link homônimo: "Financeiro" e "Compras" aparecem como cabeçalho E como link.
    for (const name of ['Financeiro', 'Compras']) {
      const at = e.findIndex((x) => x.kind === 'header' && x.text === name);
      expect(at, name).toBeGreaterThan(0);
      expect(e.filter((x) => x.kind === 'link' && x.text === name)).toHaveLength(1);
    }
    // Cada área é um bloco contíguo: todo link fica sob o cabeçalho da própria área.
    let current = 'Início';
    for (const x of e) {
      if (x.kind === 'header') current = x.text;
      else expect(navGroupOf(x.href!), x.text).toBe(current);
    }
    expect(links(e)).toHaveLength(NAV.length);
  });

  it('cada item do menu está na área e com as permissões esperadas', () => {
    expect(NAV.map((i) => i.href).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const item of NAV) {
      expect(navGroupOf(item.href), item.href).toBe(EXPECTED[item.href]!.group);
      expect(item.anyOf, item.href).toEqual(EXPECTED[item.href]!.anyOf);
      for (const p of item.anyOf ?? []) expect(isPermission(p), `${item.href}: ${p}`).toBe(true);
    }
    // F1-13: "Materiais aprovados" voltou ao menu, na área Compras.
    expect(NAV.find((i) => i.href === '/painel/materiais')?.label).toBe('Materiais aprovados');
  });

  it('itens por permissão: cada perfil vê só as áreas e links que pode abrir', () => {
    const fin = sidebar(['painel.acessar', 'financeiro.ver']);
    expect(links(fin)).toEqual(['Início', 'Recebimento de materiais', 'Financeiro']);
    expect(headers(fin)).toEqual(['Compras', 'Financeiro']);

    const pres = sidebar(['painel.acessar', 'presenca.ver']);
    expect(links(pres)).toEqual(['Início', 'Presença da equipe', 'Recebimento de materiais']);
    expect(headers(pres)).toEqual(['Produção', 'Compras']);

    const compras = sidebar(['painel.acessar', 'compras.ver']);
    expect(headers(compras)).toEqual(['Compras']);
    expect(links(compras)).toEqual([
      'Início',
      'Compras',
      'Fornecedores',
      'Recebimento de materiais',
      'Estoque',
      'Prontidão de materiais',
      'Materiais aprovados',
    ]);

    const admin = sidebar(['painel.acessar', 'funcionarios.ver', 'auditoria.ver']);
    expect(headers(admin)).toEqual(['Compras', 'Administração']);
    expect(links(admin)).toEqual([
      'Início',
      'Recebimento de materiais',
      'Funcionários',
      'Auditoria',
    ]);
  });

  it('"Recebimento de materiais" não tem filtro: qualquer usuário do painel vê o link', () => {
    // Não é vazamento: a fila e o registro do recebimento aceitam qualquer sessão autenticada
    // (GET /api/v1/material-receipts/pending e POST /api/v1/material-receipts: { session: 'any' }),
    // provado pela API em apps/api/test/rodada4-travas-estruturais.test.ts.
    const item = NAV.find((i) => i.href === '/painel/recebimento-materiais')!;
    expect(item.label).toBe('Recebimento de materiais');
    expect(item.anyOf).toBeUndefined();
    expect(links(sidebar(['painel.acessar']))).toEqual(['Início', 'Recebimento de materiais']);
  });
});
