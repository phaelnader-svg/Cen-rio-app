import { describe, expect, it } from 'vitest';
import { parseCommandRules } from '../src';

const T = '2026-11-16';
const p = (s: string) => parseCommandRules(s, T);

describe('Falar com a Cenário — regras', () => {
  it('encontrar OS por cliente e por número', () => {
    expect(p('Cadê o sofá da Hadassa?')).toMatchObject({ acao: 'ENCONTRAR_OS', termo: 'hadassa' });
    expect(p('Abre a OS 142')).toMatchObject({ acao: 'ENCONTRAR_OS', osNumero: 142 });
    expect(p('mostra a poltrona do Bruno')).toMatchObject({ acao: 'ENCONTRAR_OS', termo: 'bruno' });
  });
  it('localizar material', () => {
    expect(p('Onde fica o linho bege?')).toMatchObject({
      acao: 'LOCALIZAR_MATERIAL',
      termo: 'linho bege',
    });
    expect(p('cadê a espuma D28')).toMatchObject({
      acao: 'LOCALIZAR_MATERIAL',
      termo: 'espuma d28',
    });
  });
  it('mover objeto', () => {
    expect(p('Joga a mesa de corte pra perto da costura')).toMatchObject({
      acao: 'MOVER_OBJETO',
      objeto: 'mesa de corte',
      destino: 'costura',
    });
    expect(p('leva a estante B para a expedição')).toMatchObject({
      acao: 'MOVER_OBJETO',
      objeto: 'estante b',
      destino: 'expedicao',
    });
  });
  it('planta, atribuição, conversas e financeiro', () => {
    expect(p('coloca mais duas mesas perto da janela').acao).toBe('PLANTA');
    expect(p('aumenta o escritório dois metros').acao).toBe('PLANTA');
    expect(p('cria uma mesa para o agente de compras').acao).toBe('PLANTA');
    expect(p('Passa o desmanche da OS 2 pro João amanhã')).toMatchObject({
      acao: 'ATRIBUIR',
      osNumero: 2,
      etapa: 'DESMONTAGEM',
      funcionario: 'joao',
      data: '2026-11-17',
    });
    expect(p('quem está esperando orçamento no WhatsApp?').acao).toBe('CONVERSAS');
    expect(p('Gera a entrada por Pix da OS 142')).toMatchObject({
      acao: 'FINANCEIRO',
      osNumero: 142,
    });
  });
});
