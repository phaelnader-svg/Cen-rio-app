/**
 * Remediação pós-auditoria, Rodada 4 — F10-01: menu do painel por áreas (Início, Serviços,
 * Produção, Financeiro, Administração). A área "Compras" saiu com a remoção real de Compras,
 * Fornecedores, Recebimento de materiais, Estoque formal, Prontidão e Materiais aprovados.
 *
 * Prova pela estrutura real do menu (components/admin/nav.ts) e pela mesma regra de montagem da
 * barra lateral (components/admin/shell.tsx): filtro por permissão, ordenação por área e um
 * cabeçalho por área (exceto "Início", cuja entrada é o próprio link "Início"). Os cabeçalhos são
 * verificados separadamente dos links — "Financeiro" também é nome de link.
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
  // Aplicativos conectados (autorização delegada, ex.: Firma Viva).
  '/painel/empresas': { group: 'Administração', anyOf: ['empresa.configurar'] },
  '/painel/aplicativos': { group: 'Administração', anyOf: ['empresa.configurar', 'sessoes.ver'] },
  '/painel/clientes': { group: 'Serviços', anyOf: ['clientes.ver'] },
  '/painel/orcamentos': { group: 'Serviços', anyOf: ['orcamentos.ver', 'orcamentos.gerenciar'] },
  '/painel/pedidos': { group: 'Serviços', anyOf: ['pedidos.ver'] },
  '/painel/retiradas': { group: 'Serviços', anyOf: ['retiradas.ver'] },
  '/painel/roteiro': { group: 'Serviços', anyOf: ['entregas.ver', 'retiradas.ver'] },
  '/painel/os': { group: 'Serviços', anyOf: ['os.ver'] },
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
  '/painel/reprogramacao': { group: 'Produção', anyOf: ['producao.ver', 'producao.planejar'] },
  '/painel/producao/modelos': {
    group: 'Produção',
    anyOf: ['producao.ver', 'producao.planejar', 'qualidade.gerenciar', 'os.gerenciar'],
  },
  '/painel/estoque-oficina': { group: 'Produção', anyOf: ['estoque.ver', 'estoque.gerenciar'] },
  '/painel/qualidade': { group: 'Serviços', anyOf: ['qualidade.gerenciar'] },
  '/painel/entregas': { group: 'Serviços', anyOf: ['entregas.ver', 'entregas.gerenciar'] },
  // 2026-11-18: Retrabalhos substitui Devoluções no menu.
  '/painel/retrabalhos': { group: 'Serviços', anyOf: ['os.ver', 'os.gerenciar'] },
  // 2026-11-18: Produtividade virou item próprio (antes era aba do Financeiro).
  '/painel/produtividade': { group: 'Produção', anyOf: ['financeiro.ver'] },
  '/painel/financeiro': { group: 'Financeiro', anyOf: ['financeiro.ver'] },
  '/painel/presenca': { group: 'Produção', anyOf: ['presenca.ver', 'presenca.gerenciar'] },
  '/painel/empresa': { group: 'Administração', anyOf: ['empresa.ver'] },
  '/painel/assinatura': { group: 'Administração', anyOf: ['empresa.ver'] },
  '/painel/auditoria': { group: 'Administração', anyOf: ['auditoria.ver'] },
  '/painel/sincronizacao': { group: 'Administração', anyOf: ['sincronizacao.diagnosticar'] },
};

describe('F10-01 — menu por áreas', () => {
  it('as cinco áreas, na ordem: Início, Financeiro, Serviços, Produção, Administração', () => {
    expect([...NAV_GROUPS]).toEqual([
      'Início',
      'Financeiro',
      'Serviços',
      'Produção',
      'Administração',
    ]);
  });

  it('a barra lateral usa exatamente esta montagem (filtro, ordenação e cabeçalhos)', () => {
    const shell = readFileSync(resolve(__dirname, '../components/admin/shell.tsx'), 'utf8');
    // Homologação funcional (B1): filtro, ordenação e allOf ficam em visibleNav (nav.ts).
    expect(shell).toContain(
      'const items = visibleNav(perms, modules, data.company.platformOwner, billingOn);',
    );
    expect(shell).toContain('const header = idx === 0 || items[idx - 1]!.group !== item.group;');
    expect(shell).toContain("{header && item.group !== 'Início' && (");
  });

  it('gestor (todas as permissões): quatro cabeçalhos de área e "Início" como primeiro link', () => {
    const e = sidebar(ALL_PERMISSIONS);
    expect(headers(e)).toEqual(['Financeiro', 'Serviços', 'Produção', 'Administração']);
    expect(e[0]).toEqual({ kind: 'link', text: 'Início', href: '/painel' });
    expect(e[1]).toEqual({ kind: 'link', text: 'Central de atenção', href: '/painel/atencao' });
    // Cabeçalho ≠ link homônimo: "Financeiro" aparece como cabeçalho E como link.
    for (const name of ['Financeiro']) {
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
    // "Empresas" (multi-empresa) só aparece para o dono da plataforma.
    expect(links(e)).toHaveLength(NAV.filter((i) => !i.platformOnly).length);
    expect(links(e)).not.toContain('Empresas');
    const dono = visibleNav(
      new Set(ALL_PERMISSIONS) as ReadonlySet<Permission>,
      ALL_MODULES_ON,
      true,
    );
    expect(dono.map((i) => i.href)).toContain('/painel/empresas');
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
    // Remoção real: nenhum item dos módulos removidos voltou ao menu.
    for (const href of [
      '/painel/recebimentos',
      '/painel/medicoes',
      '/painel/ajuda',
      '/painel/compras',
      '/painel/fornecedores',
      '/painel/recebimento-materiais',
      '/painel/estoque',
      '/painel/prontidao',
      '/painel/materiais',
    ])
      expect(NAV.find((i) => i.href === href)).toBeUndefined();
  });

  it('Reformulação Fase 3: área Produção enxuta (8 links), sem perder rotas', () => {
    const e = sidebar(ALL_PERMISSIONS);
    const start = e.findIndex((x) => x.kind === 'header' && x.text === 'Produção');
    const end = e.findIndex((x, i) => i > start && x.kind === 'header');
    expect(links(e.slice(start, end))).toEqual([
      'Programação semanal',
      'Quadro de produção',
      'Mapa da oficina',
      'Reprogramação',
      'Modelos de serviço',
      'Estoque da oficina',
      'Presença da equipe',
      'Produtividade',
    ]);
    // Saíram do menu, mas as páginas continuam existindo (abrem pelo endereço e por link).
    for (const page of [
      'producao/a-planejar/page.tsx',
      'producao/planejamento/page.tsx',
      'competencias/page.tsx',
    ])
      expect(existsSync(resolve(__dirname, '../app/painel', page)), page).toBe(true);
  });

  it('itens por permissão: cada perfil vê só as áreas e links que pode abrir', () => {
    const fin = sidebar(['painel.acessar', 'financeiro.ver']);
    expect(links(fin)).toEqual(['Início', 'Financeiro', 'Produtividade']);
    expect(headers(fin)).toEqual(['Financeiro', 'Produção']);

    const pres = sidebar(['painel.acessar', 'presenca.ver']);
    expect(links(pres)).toEqual(['Início', 'Presença da equipe']);
    expect(headers(pres)).toEqual(['Produção']);

    const estoque = sidebar(['painel.acessar', 'estoque.ver']);
    expect(headers(estoque)).toEqual(['Produção']);
    expect(links(estoque)).toEqual(['Início', 'Estoque da oficina']);

    const admin = sidebar(['painel.acessar', 'funcionarios.ver', 'auditoria.ver']);
    expect(headers(admin)).toEqual(['Administração']);
    expect(links(admin)).toEqual(['Início', 'Funcionários', 'Auditoria']);

    // Sem nenhuma permissão de área: só "Início" (o antigo link sem filtro saiu com o módulo).
    expect(links(sidebar(['painel.acessar']))).toEqual(['Início']);
  });
});

/** Homologação funcional F′ — B1 e B6: menu × permissões efetivas da API (B2 saiu com o módulo). */
describe('Menu alinhado às permissões da API (B1, B6)', () => {
  const tem = (perms: string[], href: string) =>
    links(sidebar(['painel.acessar', ...perms])).includes(NAV.find((i) => i.href === href)!.label);
  it('B1: "Novo serviço" só com pedidos.gerenciar E retiradas.gerenciar', () => {
    expect(tem(['pedidos.gerenciar'], '/painel/servicos/novo')).toBe(false);
    expect(tem(['retiradas.gerenciar'], '/painel/servicos/novo')).toBe(false);
    expect(tem(['pedidos.gerenciar', 'retiradas.gerenciar'], '/painel/servicos/novo')).toBe(true);
  });
  it('Retrabalhos (substitui Devoluções no menu): com os.ver OU os.gerenciar', () => {
    expect(NAV.find((i) => i.href === '/painel/devolucoes')).toBeUndefined();
    expect(tem(['os.ver'], '/painel/retrabalhos')).toBe(true);
    expect(tem(['os.gerenciar'], '/painel/retrabalhos')).toBe(true);
    expect(tem(['pedidos.ver', 'clientes.ver'], '/painel/retrabalhos')).toBe(false);
  });
  it('nenhuma permissão nova foi criada para o menu', () => {
    for (const i of NAV)
      for (const p of [...(i.anyOf ?? []), ...(i.allOf ?? [])]) expect(isPermission(p)).toBe(true);
  });
});
