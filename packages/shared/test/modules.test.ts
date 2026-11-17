import { describe, expect, it } from 'vitest';
import {
  MODULES,
  MODULE_KEYS,
  NOTIFICATION_KINDS,
  hiddenNotificationKinds,
  resolveModules,
  updateModuleSchema,
} from '../src';

/** Reformulação, Fase 0 — interruptores de funcionalidades. */
describe('módulos configuráveis', () => {
  it('sem nenhum registro, a logística fica ligada; o ambiente interativo depende do plano', () => {
    const state = resolveModules([]);
    expect(Object.keys(state).sort()).toEqual([...MODULE_KEYS].sort());
    expect(MODULES.logistica.defaultEnabled).toBe(true);
    // Cobrança: o jogo vem desligado e quem liga é o plano (core/modules.ts no servidor).
    expect(MODULES.ambiente_interativo.defaultEnabled).toBe(false);
    expect(state).toEqual({ logistica: true, ambiente_interativo: false });
  });

  it('S1 e remoção dos módulos: só a logística é configurável; registros antigos de "embalagem", "ajuda" e "materiais" são ignorados', () => {
    expect(MODULE_KEYS.filter((k) => MODULES[k].configurable)).toEqual(['logistica']);
    const state = resolveModules([
      { key: 'logistica', enabled: false },
      { key: 'embalagem', enabled: false },
      { key: 'ajuda', enabled: true },
      { key: 'materiais', enabled: true },
    ]);
    expect(state).toEqual({ logistica: false, ambiente_interativo: false });
  });

  it('chave desconhecida (gravada por versão futura) é ignorada sem erro', () => {
    expect(resolveModules([{ key: 'modulo-futuro', enabled: false }])).toEqual(resolveModules([]));
  });

  it('avisos dos pedidos de ajuda (removidos) nunca aparecem; todos são tipos de aviso válidos', () => {
    const hidden = hiddenNotificationKinds(resolveModules([]));
    expect(hidden.length).toBe(5);
    expect(hidden.every((k) => k.startsWith('AJUDA_'))).toBe(true);
    for (const k of hidden) expect(NOTIFICATION_KINDS as readonly string[]).toContain(k);
    // Todo aviso AJUDA_* do catálogo está coberto (nenhum fica visível por esquecimento).
    expect(NOTIFICATION_KINDS.filter((k) => k.startsWith('AJUDA_')).sort()).toEqual(
      [...hidden].sort(),
    );
  });

  it('Fase 1: logística desligada esconde também os avisos de entrega agendada; todos são tipos válidos', () => {
    const hidden = hiddenNotificationKinds(resolveModules([{ key: 'logistica', enabled: false }]));
    expect(hidden.filter((k) => !k.startsWith('AJUDA_')).sort()).toEqual([
      'ENTREGA_AGENDADA',
      'ENTREGA_ATRIBUIDA',
      'ENTREGA_CONCLUIDA',
    ]);
    for (const k of hidden) expect(NOTIFICATION_KINDS as readonly string[]).toContain(k);
  });

  it('entrada da alteração: só booleano e versão inteira ≥ 0', () => {
    expect(updateModuleSchema.safeParse({ enabled: false, version: 0 }).success).toBe(true);
    expect(updateModuleSchema.safeParse({ enabled: 'false', version: 0 }).success).toBe(false);
    expect(updateModuleSchema.safeParse({ enabled: true, version: -1 }).success).toBe(false);
    expect(updateModuleSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});
