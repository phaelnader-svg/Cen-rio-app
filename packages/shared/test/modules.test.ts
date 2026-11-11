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
  it('sem nenhum registro, tudo fica no padrão — e todo padrão preserva o comportamento anterior (ligado)', () => {
    const state = resolveModules([]);
    expect(Object.keys(state).sort()).toEqual([...MODULE_KEYS].sort());
    for (const k of MODULE_KEYS) {
      expect(MODULES[k].defaultEnabled).toBe(true);
      expect(state[k]).toBe(true);
    }
  });

  it('Fase 3: as quatro funcionalidades são configuráveis (a embalagem passou a ser); registro gravado vale', () => {
    expect(MODULE_KEYS.filter((k) => MODULES[k].configurable)).toEqual([
      'logistica',
      'ajuda',
      'embalagem',
      'materiais',
    ]);
    const state = resolveModules([
      { key: 'logistica', enabled: false },
      { key: 'embalagem', enabled: false },
      { key: 'ajuda', enabled: false },
      { key: 'materiais', enabled: false },
    ]);
    expect(state).toEqual({ logistica: false, embalagem: false, ajuda: false, materiais: false });
    // Sem registro, tudo ligado (comportamento anterior preservado).
    expect(resolveModules([])).toEqual({
      logistica: true,
      ajuda: true,
      embalagem: true,
      materiais: true,
    });
  });

  it('chave desconhecida (gravada por versão futura) é ignorada sem erro', () => {
    expect(resolveModules([{ key: 'modulo-futuro', enabled: false }])).toEqual(resolveModules([]));
  });

  it('avisos escondidos: só os de ajuda, e só com a ajuda desligada; todos são tipos de aviso válidos', () => {
    expect(hiddenNotificationKinds(resolveModules([]))).toEqual([]);
    const hidden = hiddenNotificationKinds(resolveModules([{ key: 'ajuda', enabled: false }]));
    expect(hidden.length).toBe(5);
    expect(hidden.every((k) => k.startsWith('AJUDA_'))).toBe(true);
    for (const k of hidden) expect(NOTIFICATION_KINDS as readonly string[]).toContain(k);
    // Todo aviso AJUDA_* do catálogo está coberto (nenhum fica visível por esquecimento).
    expect(NOTIFICATION_KINDS.filter((k) => k.startsWith('AJUDA_')).sort()).toEqual(
      [...hidden].sort(),
    );
  });

  it('Fase 1: logística desligada esconde só os avisos de entrega agendada; todos são tipos válidos', () => {
    const hidden = hiddenNotificationKinds(resolveModules([{ key: 'logistica', enabled: false }]));
    expect(hidden.sort()).toEqual(['ENTREGA_AGENDADA', 'ENTREGA_ATRIBUIDA', 'ENTREGA_CONCLUIDA']);
    for (const k of hidden) expect(NOTIFICATION_KINDS as readonly string[]).toContain(k);
    expect(hiddenNotificationKinds(resolveModules([{ key: 'materiais', enabled: false }]))).toEqual(
      [],
    );
  });

  it('entrada da alteração: só booleano e versão inteira ≥ 0', () => {
    expect(updateModuleSchema.safeParse({ enabled: false, version: 0 }).success).toBe(true);
    expect(updateModuleSchema.safeParse({ enabled: 'false', version: 0 }).success).toBe(false);
    expect(updateModuleSchema.safeParse({ enabled: true, version: -1 }).success).toBe(false);
    expect(updateModuleSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});
