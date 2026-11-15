/**
 * Reformulação por remoção real — S0, GRUPO A (web): o que FICA continua existindo.
 * Páginas, componentes e itens de menu das funcionalidades mantidas pelo dono (D2 estoque simples,
 * D4 devoluções, D7 mapa da oficina, lista simples de materiais, entrega direta, tablets, qualidade,
 * financeiro). Obrigatório durante toda a reformulação.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV } from '../components/admin/nav';
import { COMPONENTES_MANTIDOS, PAGINAS_MANTIDAS, WEB, paginaExiste } from './remocao-catalogo';

describe('Remoção real — Grupo A (web): o que FICA', () => {
  it.each(PAGINAS_MANTIDAS)('página mantida existe: %s', (rota) => {
    expect(paginaExiste(rota)).toBe(true);
  });
  it.each(COMPONENTES_MANTIDOS)('componente mantido existe: %s', (c) => {
    expect(existsSync(resolve(WEB, c))).toBe(true);
  });
  it('menu continua com as entradas operacionais mantidas', () => {
    const hrefs = new Set(NAV.map((i) => i.href));
    for (const h of [
      '/painel/clientes',
      '/painel/os',
      '/painel/producao/mapa',
      '/painel/devolucoes',
      '/painel/estoque-oficina',
      '/painel/qualidade',
      '/painel/financeiro',
    ])
      expect(hrefs.has(h), h).toBe(true);
  });
});
