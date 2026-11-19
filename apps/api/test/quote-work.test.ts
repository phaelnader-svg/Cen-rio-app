import { describe, expect, it } from 'vitest';
import {
  materialDescription,
  ownInstructions,
  ownItemNotes,
  quoteWork,
} from '../src/modules/service-orders/quote-work';

/** 2026-11-19 (Raphael): o orçamento em partes na OS, sem texto repetido. */
const quote = {
  number: 10212,
  snapshot: {
    fabrics: ['Corvin Marítimo'],
    upholstery: { name: 'Poltrona simples', priceCents: 25000 },
    sofaCount: 1,
    foamChange: true,
    fabricChange: true,
    lines: [],
  },
  workOrder: {
    fabricName: 'Corvin Marítimo',
    fabricMeters: 4,
    keepOriginal: 'Não',
    changeFoam: 'Sim',
    changeFabric: 'Sim',
    repairStructure: 'Avaliar',
    notes: 'Manter os pés originais.',
    items: [
      {
        category: 'Tecidos',
        name: 'Corvin Marítimo',
        unit: 'm',
        qty: 4,
        realQty: 4,
        heightCm: 0,
        widthCm: 0,
        lengthCm: 0,
      },
      {
        category: 'Espumas',
        name: 'Espuma D33',
        unit: 'm³',
        qty: 2,
        realQty: 2,
        heightCm: 10,
        widthCm: 55.5,
        lengthCm: 60,
      },
      {
        category: 'Insumos',
        name: 'Grampo',
        unit: 'un',
        qty: 0,
        realQty: 0,
        heightCm: 0,
        widthCm: 0,
        lengthCm: 0,
      },
    ],
  },
};

describe('quoteWork', () => {
  it('separa serviço, marcas, tecido e materiais com as medidas da espuma', () => {
    const w = quoteWork(quote);
    expect(w).toMatchObject({
      number: 10212,
      upholsteryService: 'Poltrona simples',
      fabricName: 'Corvin Marítimo',
      fabricMeters: 4,
      notes: 'Manter os pés originais.',
    });
    expect(w.checks.map((c) => `${c.label}: ${c.value}`)).toEqual([
      'Trocar tecido: Sim',
      'Trocar espuma: Sim',
      'Reparar estrutura: Avaliar',
      'Manter o original: Não',
    ]);
    expect(w.materials).toHaveLength(2);
    expect(w.materials[1]).toMatchObject({ unit: 'peças', size: '10 × 55,5 × 60 cm' });
    expect(materialDescription(w.materials[1]!)).toBe('Espuma D33 — 10 × 55,5 × 60 cm');
  });

  it('OS antiga: tira as linhas automáticas e deixa o que alguém escreveu', () => {
    const w = quoteWork(quote);
    const old = [
      'Serviço do tapeceiro: Poltrona simples.',
      'Orçamento nº 10212. Tecido: Corvin Marítimo. Troca de espuma: sim.',
      'Costura dupla no assento.',
      'Manter o original: Não · Trocar espuma: Sim',
      'Materiais do orçamento: Corvin Marítimo (4 m).',
      'Manter os pés originais.',
    ].join('\n');
    expect(ownInstructions(old, w)).toBe('Costura dupla no assento.');
    expect(ownInstructions(old, null)).toBe(old);
    expect(ownItemNotes('Serviço do tapeceiro: Poltrona simples', w)).toBeNull();
    expect(ownItemNotes('Cuidado com o braço', w)).toBe('Cuidado com o braço');
  });
});
