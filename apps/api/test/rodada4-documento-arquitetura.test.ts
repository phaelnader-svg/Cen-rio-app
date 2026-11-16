import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Remediação pós-auditoria, Rodada 4 — provas estruturais de F1-01 e F1-02b.
 *
 * - F1-01: o documento da Fase 1 tem as 19 seções na ordem, a §20 (matriz de rastreabilidade)
 *   e os critérios de aceite CA1-01..CA1-16. CA1-02 (versão publicada na homologação) é fato
 *   de ambiente: fica provado pela homologação de cada rodada (`version` no fluxo seguro), não
 *   por este teste.
 * - F1-02b: reaproveitamento sem duplicação — cada registro físico tem UM ponto de criação no
 *   código e as entradas novas (chegada pelo tablet, Central do Gestor) chamam esses pontos em
 *   vez de reimplementá-los. Uma segunda implementação faria este teste falhar.
 */
const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'apps/api/src');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
/** Arquivos (relativos a apps/api/src) que contêm o padrão. */
const filesWith = (pattern: RegExp) =>
  sources(SRC)
    .filter((p) => pattern.test(readFileSync(p, 'utf8')))
    .map((p) => relative(SRC, p))
    .sort();

describe('F1-01 — documento da Fase 1 (19 seções + matriz)', () => {
  const doc = read('docs/SIMPLIFICACAO-FASE-1-AUDITORIA-ARQUITETURA.md');
  const sections = [...doc.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => Number(m[1]));

  it('as seções 1 a 19 existem, em ordem, seguidas da §20 (matriz de rastreabilidade)', () => {
    expect(sections).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(doc).toMatch(/^## 20\. Matriz de rastreabilidade$/m);
  });

  it('a matriz de rastreabilidade liga requisitos às fases 2–10 do plano', () => {
    const matrix = doc.slice(doc.indexOf('## 20. Matriz de rastreabilidade'));
    const rows = matrix
      .split('\n')
      .filter((l) => /^\| [^-|]/.test(l))
      .slice(1);
    expect(rows.length).toBeGreaterThan(20);
    const phases = new Set(
      rows.flatMap((r) => [...r.matchAll(/\b(10|[2-9])\b/g)].map((m) => m[1])),
    );
    for (const f of ['2', '3', '4', '5', '6', '7', '8', '9', '10']) expect(phases).toContain(f);
  });

  it('os critérios de aceite CA1-01..CA1-16 estão todos registrados (com o resultado de cada um)', () => {
    for (let i = 1; i <= 16; i += 1)
      expect(doc).toMatch(new RegExp(`^\\| CA1-${String(i).padStart(2, '0')} \\|.+\\|.+\\|$`, 'm'));
  });
});

describe('F1-02b — reaproveitamento de módulos sem duplicação', () => {
  it('recebimento de peças: um único ponto de criação, usado pela chegada no tablet', () => {
    expect(filesWith(/\.receipt\.create\(/)).toEqual(['modules/receipts/service.ts']);
    const arrivals = read('apps/api/src/modules/arrivals/routes.ts');
    expect(arrivals).toMatch(/import \{[^}]*registerReceipt[^}]*\} from '\.\.\/receipts\/service'/);
    expect(arrivals).toMatch(/registerReceipt\(/);
  });

  it('recebimento de materiais: um único ponto de criação, usado pela chegada de materiais', () => {
    expect(filesWith(/\.materialReceipt\.create\(/)).toEqual(['modules/purchasing/receipts.ts']);
    const arrivals = read('apps/api/src/modules/arrivals/routes.ts');
    expect(arrivals).toMatch(
      /import \{[^}]*registerMaterialReceipt[^}]*\} from '\.\.\/purchasing\/receipts'/,
    );
  });

  it('estoque: movimentações nascem num único lugar', () => {
    expect(filesWith(/\.stockMovement\.create\(/)).toEqual(['modules/purchasing/common.ts']);
  });

  it('Central do Gestor estende a Central existente (uma rota, uma montagem)', () => {
    expect(filesWith(/'\/api\/v1\/attention'/)).toEqual(['modules/issues/attention.ts']);
    expect(filesWith(/managementAttention\(/).sort()).toEqual(
      ['modules/issues/attention.ts', 'modules/management/attention.ts'].sort(),
    );
    // O Início conta as pendências pela MESMA montagem da Central (sem segunda regra).
    expect(read('apps/api/src/modules/management/routes.ts')).toMatch(/loadAttention\(/);
  });
});
