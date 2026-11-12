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
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_PERMISSIONS, MODULE_KEYS, isPermission, type Permission } from '@cenario/shared';
import { describe, expect, it } from 'vitest';
import { NAV, NAV_GROUPS, navGroupOf, visibleNav } from '../components/admin/nav';

const ALL_MODULES_ON = Object.fromEntries(MODULE_KEYS.map((k) => [k, true]));

type Entry = { kind: 'header' | 'link'; text: string; href?: string };

/** Mesma montagem de shell.tsx: filtra por permissão, ordena por área e põe os cabeçalhos. */
function sidebar(perms: readonly string[]): Entry[] {
  // A mesma função usada pela barra lateral (shell.tsx), com todas as funcionalidades ligadas.
  const items = visibleNav(new Set(perms) as ReadonlySet<Permission>, ALL_MODULES_ON);
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
const EXPECTED: Record<string, { group: string; anyOf?: string[]; allOf?: string[] }> = {
  '/painel': { group: 'Início' },
  // B1 (homologação funcional): a tela exige as DUAS permissões na API.
  '/painel/servicos/novo': {
    group: 'Serviços',
    allOf: ['pedidos.gerenciar', 'retiradas.gerenciar'],
  },
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
  '/painel/producao/programacao': {
    group: 'Produção',
    anyOf: ['producao.ver', 'producao.planejar'],
  },
  '/painel/producao': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/producao/mapa': {
    group: 'Produção',
    anyOf: [
      'os.ver',
      'producao.ver',
      'producao.planejar',
      'qualidade.gerenciar',
      'entregas.ver',
      'entregas.gerenciar',
    ],
  },
  '/painel/ajuda': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/reprogramacao': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/producao/modelos': {
    group: 'Produção',
    anyOf: ['producao.ver', 'producao.planejar', 'qualidade.gerenciar', 'os.gerenciar'],
  },
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
  '/painel/estoque-oficina': { group: 'Compras', anyOf: ['estoque.ver', 'estoque.gerenciar'] },
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
  // B6: as mesmas permissões que a API aceita para consultar (RETURNS_VIEW).
  '/painel/devolucoes': { group: 'Serviços', anyOf: ['devolucoes.gerenciar', 'pedidos.ver'] },
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
    // Homologação funcional (B1): filtro, ordenação e allOf ficam em visibleNav (nav.ts).
    expect(shell).toContain('const items = visibleNav(perms, modules);');
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
      expect(item.allOf, item.href).toEqual(EXPECTED[item.href]!.allOf);
      for (const p of [...(item.anyOf ?? []), ...(item.allOf ?? [])])
        expect(isPermission(p), `${item.href}: ${p}`).toBe(true);
    }
    // F1-13: "Materiais aprovados" voltou ao menu, na área Compras.
    expect(NAV.find((i) => i.href === '/painel/materiais')?.label).toBe('Materiais aprovados');
  });

  it('Reformulação Fase 3: área Produção enxuta (8 links), sem perder rotas', () => {
    const e = sidebar(ALL_PERMISSIONS);
    const start = e.findIndex((x) => x.kind === 'header' && x.text === 'Produção');
    const end = e.findIndex((x, i) => i > start && x.kind === 'header');
    expect(links(e.slice(start, end))).toEqual([
      'Medições',
      'Programação semanal',
      'Quadro de produção',
      'Mapa da oficina',
      'Pedidos de ajuda',
      'Reprogramação',
      'Modelos de serviço',
      'Presença da equipe',
    ]);
    // Saíram do menu, mas as páginas continuam existindo (abrem pelo endereço e por link).
    for (const page of [
      'planejamento/page.tsx',
      'producao/a-planejar/page.tsx',
      'producao/planejamento/page.tsx',
      'competencias/page.tsx',
    ])
      expect(existsSync(resolve(__dirname, '../app/painel', page)), page).toBe(true);
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

/** Homologação funcional F′ — B1, B2 e B6: menu × permissões efetivas da API. */
describe('Menu alinhado às permissões da API (B1, B2, B6)', () => {
  const tem = (perms: string[], href: string) =>
    links(sidebar(['painel.acessar', ...perms])).includes(NAV.find((i) => i.href === href)!.label);
  it('B1: "Novo serviço" só com pedidos.gerenciar E retiradas.gerenciar', () => {
    expect(tem(['pedidos.gerenciar'], '/painel/servicos/novo')).toBe(false);
    expect(tem(['retiradas.gerenciar'], '/painel/servicos/novo')).toBe(false);
    expect(tem(['pedidos.gerenciar', 'retiradas.gerenciar'], '/painel/servicos/novo')).toBe(true);
  });
  it('B2: "Recebimento de materiais" para todo funcionário (API: ANY_EMPLOYEE)', () => {
    expect(tem([], '/painel/recebimento-materiais')).toBe(true);
    expect(tem(['os.ver'], '/painel/recebimento-materiais')).toBe(true);
  });
  it('B6: "Devoluções" com devolucoes.gerenciar OU pedidos.ver (API: RETURNS_VIEW)', () => {
    expect(tem(['pedidos.ver'], '/painel/devolucoes')).toBe(true);
    expect(tem(['devolucoes.gerenciar'], '/painel/devolucoes')).toBe(true);
    expect(tem(['os.ver', 'clientes.ver'], '/painel/devolucoes')).toBe(false);
  });
  it('nenhuma permissão nova foi criada para o menu', () => {
    for (const i of NAV)
      for (const p of [...(i.anyOf ?? []), ...(i.allOf ?? [])]) expect(isPermission(p)).toBe(true);
  });
});
