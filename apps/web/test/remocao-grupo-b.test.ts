/**
 * Reformulação por remoção real — S0, GRUPO B (web): requisitos FUTUROS (S1–S7).
 * Enquanto a etapa não estiver em tests/remocao/etapas-concluidas.json, cada teste roda como
 * `it.fails` (prova que ainda não foi removido, sem quebrar a regressão). Concluída a etapa, vira
 * obrigatório: nenhum item de menu, página operacional, componente ou chamada de API removida.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV } from '../components/admin/nav';
import {
  COMPONENTES_REMOVIDOS,
  type Etapa,
  PAGINAS_REMOVIDAS,
  TRECHOS_PROIBIDOS,
  WEB,
  etapasConcluidas,
  paginaRemovida,
} from './remocao-catalogo';

const CONCLUIDAS = etapasConcluidas();
const futuro = (e: Etapa) => (CONCLUIDAS.has(e) ? it : it.fails);
const ETAPAS: Etapa[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

function fontes(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.next' || n === 'test') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) fontes(p, acc);
    else if (/\.(tsx?|mjs)$/.test(n)) acc.push(p);
  }
  return acc;
}
const ARQUIVOS = [
  ...fontes(resolve(WEB, 'app')),
  ...fontes(resolve(WEB, 'components')),
  ...fontes(resolve(WEB, 'lib')),
];

describe('Remoção real — Grupo B (web)', () => {
  for (const e of ETAPAS) {
    const paginas = PAGINAS_REMOVIDAS[e];
    if (paginas.length)
      futuro(e)(`${e}: sem menu e sem página operacional (${paginas.join(', ')})`, () => {
        const noMenu = NAV.filter((i) =>
          paginas.some((p) => i.href === p || i.href.startsWith(`${p}/`)),
        );
        expect(noMenu.map((i) => i.href)).toEqual([]);
        expect(paginas.filter((p) => !paginaRemovida(p))).toEqual([]);
      });
    const comps = COMPONENTES_REMOVIDOS[e];
    if (comps.length)
      futuro(e)(`${e}: componentes removidos do código (${comps.length})`, () => {
        expect(comps.filter((c) => existsSync(resolve(WEB, c)))).toEqual([]);
      });
    const trechos = TRECHOS_PROIBIDOS[e];
    if (trechos.length)
      futuro(e)(
        `${e}: nenhuma tela chama as APIs/recursos removidos (${trechos.join(' · ')})`,
        () => {
          const achados: string[] = [];
          for (const f of ARQUIVOS) {
            const t = readFileSync(f, 'utf8');
            for (const s of trechos)
              if (t.includes(s)) achados.push(`${f.slice(WEB.length + 1)}: ${s}`);
          }
          expect(achados).toEqual([]);
        },
      );
  }
});
