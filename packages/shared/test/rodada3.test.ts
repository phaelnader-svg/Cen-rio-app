import { describe, expect, it } from 'vitest';
import {
  CONSOLIDATED_CSV_NOTE,
  DRAFT_STALE_DAYS,
  audienceAllows,
  consolidatedToCsv,
  draftAgeDays,
  receivingSituation,
  type ConsolidatedLine,
} from '../src';

/** Remediação pós-auditoria, Rodada 3 — regras puras (compras, CSV, tempo real). */
describe('F6-03 — situação do recebimento', () => {
  it('cada situação distinta, com a chegada aguardando conferência acima do status do pedido', () => {
    const s = (status: Parameters<typeof receivingSituation>[0]['status'], p = 0, c = 0) =>
      receivingSituation({ status, pendingConference: p, conferred: c });
    expect(s('RASCUNHO')).toBeNull();
    expect(s('CONFIRMADO')).toBe('AGUARDANDO_ENTREGA');
    expect(s('PARCIALMENTE_RECEBIDO')).toBe('PARCIALMENTE_RECEBIDO');
    expect(s('RECEBIDO')).toBe('RECEBIDO');
    expect(s('RECEBIDO', 0, 1)).toBe('CONFERIDO');
    expect(s('RECEBIDO', 1, 1)).toBe('AGUARDANDO_CONFERENCIA');
    expect(s('PARCIALMENTE_RECEBIDO', 1)).toBe('AGUARDANDO_CONFERENCIA');
    expect(s('CANCELADO', 1)).toBe('CANCELADO');
  });
});

describe('F6-14 (D10) — idade do rascunho pela data da oficina', () => {
  const TZ = 'America/Sao_Paulo';
  it('conta dias do fuso da oficina, não do UTC', () => {
    // 02:30 UTC de 20/10 ainda é 19/10 (23:30) em São Paulo.
    const late = new Date('2026-10-20T02:30:00Z');
    expect(draftAgeDays(late, '2026-10-20', TZ)).toBe(1);
    expect(draftAgeDays(late, '2026-10-20', 'UTC')).toBe(0);
    // 03:00 UTC = meia-noite local: já é o mesmo dia.
    expect(draftAgeDays(new Date('2026-10-20T03:00:00Z'), '2026-10-20', TZ)).toBe(0);
  });
  it('limiar, virada de mês e data futura (relógio) sem número negativo', () => {
    expect(DRAFT_STALE_DAYS).toBe(3);
    expect(draftAgeDays(new Date('2026-09-28T15:00:00Z'), '2026-10-01', TZ)).toBe(3);
    expect(draftAgeDays(new Date('2026-10-02T15:00:00Z'), '2026-10-01', TZ)).toBe(0);
  });
});

describe('F6-10 — CSV da lista consolidada', () => {
  const line = (over: Partial<ConsolidatedLine> = {}): ConsolidatedLine => ({
    key: 'k',
    kind: 'TECIDO',
    sourcing: 'EXCLUSIVO_OS',
    description: 'Linho',
    color: 'Bege',
    reference: null,
    foamDensity: null,
    thicknessCm: null,
    lengthCm: null,
    widthCm: null,
    unit: 'METRO',
    totalQuantity: 13.5,
    serviceOrder: { id: 'x', code: 'OS-00001' },
    origins: [
      {
        serviceOrderCode: 'OS-00001',
        itemCode: 'OS-00001/1',
        measurementCode: null,
        quantity: 13.5,
      },
    ],
    ...over,
  });
  it('BOM UTF-8, cabeçalho, CRLF e rótulo "BRUTA" em toda linha; nenhum preço', () => {
    const csv = consolidatedToCsv([line(), line({ key: 'b', description: 'Veludo' })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = csv.slice(1).split('\r\n').filter(Boolean);
    expect(rows[0]).toBe('Tipo;Material;Quantidade;Unidade;Destino;Origens;Lista');
    expect(rows).toHaveLength(3);
    for (const r of rows.slice(1)) expect(r.endsWith(`;${CONSOLIDATED_CSV_NOTE}`)).toBe(true);
    expect(csv).not.toMatch(/R\$|Cents|preço/i);
  });
  it('escapa ponto e vírgula, aspas e quebras de linha (inclusive \\r)', () => {
    const csv = consolidatedToCsv([line({ description: 'Linho "fino"; lote\r\n2' })]);
    expect(csv).toContain('"Linho ""fino""; lote\r\n2 Bege"');
  });
});

describe('F1-09 — audiência por tipo de sessão', () => {
  const tablet = (perms: string[]) => ({
    kind: 'DEVICE' as const,
    userId: 'u1',
    permissions: new Set(perms),
  });
  const web = (perms: string[]) => ({ ...tablet(perms), kind: 'WEB' as const });
  it('tablet com permissão gerencial NÃO recebe o evento dessa audiência; o painel recebe', () => {
    expect(audienceAllows('permission:financeiro.ver', tablet(['financeiro.ver']))).toBe(false);
    expect(audienceAllows('permission:financeiro.ver', web(['financeiro.ver']))).toBe(true);
    expect(
      audienceAllows('permission:ocorrencias.gerenciar', tablet(['ocorrencias.gerenciar'])),
    ).toBe(false);
  });
  it('tablet continua recebendo o próprio e as audiências operacionais', () => {
    expect(audienceAllows('user:u1', tablet([]))).toBe(true);
    expect(audienceAllows('user:u2', tablet([]))).toBe(false);
    expect(audienceAllows('permission:producao.executar', tablet(['producao.executar']))).toBe(
      true,
    );
    expect(audienceAllows('all', tablet([]))).toBe(true);
  });
});
