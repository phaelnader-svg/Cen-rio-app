import type { QuoteSnapshot, QuoteWorkDto, QuoteWorkOrder } from '@cenario/shared';
import type { Prisma } from '@cenario/db';

/**
 * 2026-11-19 (Raphael): o que o orçamento aprovado diz sobre a execução, em partes separadas.
 * Antes tudo virava um texto só (instruções técnicas), com o tecido, a troca de espuma e os
 * materiais repetidos; agora a tela de gerar OS e a página da OS mostram cada coisa uma vez.
 */

const num = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');

export function quoteWork(quote: {
  number: number;
  snapshot: Prisma.JsonValue;
  workOrder: Prisma.JsonValue;
}): QuoteWorkDto {
  const snap = (quote.snapshot ?? {}) as Partial<QuoteSnapshot>;
  const wo = (quote.workOrder ?? null) as Partial<QuoteWorkOrder> | null;
  const checks: QuoteWorkDto['checks'] = [];
  if (wo) {
    if (wo.changeFabric) checks.push({ label: 'Trocar tecido', value: wo.changeFabric });
    if (wo.changeFoam) checks.push({ label: 'Trocar espuma', value: wo.changeFoam });
    if (wo.repairStructure) checks.push({ label: 'Reparar estrutura', value: wo.repairStructure });
    if (wo.keepOriginal) checks.push({ label: 'Manter o original', value: wo.keepOriginal });
  } else {
    if (snap.fabricChange !== undefined)
      checks.push({ label: 'Trocar tecido', value: snap.fabricChange ? 'Sim' : 'Não' });
    if (snap.foamChange !== undefined)
      checks.push({ label: 'Trocar espuma', value: snap.foamChange ? 'Sim' : 'Não' });
  }
  const lines = (wo?.items ?? snap.lines ?? []).filter(Boolean);
  const materials = lines
    .map((l) => {
      const quantity = ('realQty' in l ? l.realQty : l.qty) ?? 0;
      const foam = l.category === 'Espumas';
      const dims = [l.heightCm, l.widthCm, l.lengthCm];
      return {
        category: l.category,
        name: l.name.trim(),
        quantity,
        unit: foam ? (quantity === 1 ? 'peça' : 'peças') : l.unit,
        size: foam && dims.every((d) => d > 0) ? `${dims.map(num).join(' × ')} cm` : null,
      };
    })
    .filter((m) => m.name && m.quantity > 0);
  const fabrics = (snap.fabrics ?? []).filter(Boolean);
  return {
    number: quote.number,
    upholsteryService: snap.upholstery?.name?.trim() || null,
    fabricName: wo?.fabricName?.trim() || fabrics.join(', '),
    fabricMeters: wo?.fabricMeters ?? null,
    pieces: snap.sofaCount && snap.sofaCount > 1 ? snap.sofaCount : 1,
    checks,
    notes: wo?.notes?.trim() ?? '',
    materials,
  };
}

/** Quantidade como texto ("10", "2,5"). */
export const quantityText = num;

/** Linha da lista de materiais da OS a partir do material do orçamento. */
export function materialDescription(m: QuoteWorkDto['materials'][number]): string {
  return (m.size ? `${m.name} — ${m.size}` : m.name).slice(0, 200);
}

/**
 * OS antigas: as instruções técnicas guardavam um texto montado do orçamento (serviço do
 * tapeceiro, "Orçamento nº…", troca de espuma, materiais). Com o orçamento mostrado em partes, essas
 * linhas saem da página — fica só o que alguém escreveu.
 */
export function ownInstructions(text: string | null, work: QuoteWorkDto | null): string | null {
  if (!text) return null;
  if (!work) return text.trim() || null;
  const auto = [
    /^Serviço do tapeceiro:/i,
    /^Orçamento nº/i,
    /^Materiais do orçamento:/i,
    /^(Quantidade|Manter o original|Trocar espuma|Trocar tecido|Reparar estrutura|Tecido): /i,
  ];
  const kept = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !auto.some((re) => re.test(l)) && l !== work.notes);
  return kept.join('\n') || null;
}

/** Observação técnica da peça igual ao serviço do tapeceiro (texto automático antigo) sai. */
export function ownItemNotes(text: string | null, work: QuoteWorkDto | null): string | null {
  if (!text?.trim()) return null;
  if (work?.upholsteryService && /^Serviço do tapeceiro:/i.test(text.trim())) return null;
  return text.trim();
}
