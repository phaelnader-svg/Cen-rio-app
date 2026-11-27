'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/field';
import { FormGrid, MoneyField, NumberField, SelectField, SummaryRow } from '@/components/ui/form';
import { CALC_PIECES, calcPrice } from './calc';

const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Número digitado com vírgula ("1,5") ou ponto. */
const num = (v: string) => Number(v.replace(',', '.'));

/**
 * Item 28: calculadora de preço de reforma. Roda toda no navegador: nada é enviado nem guardado.
 * Os campos calculados ficam travados (cinza, só leitura), como no orçamento do sistema.
 */
export function PriceCalculator() {
  const [piece, setPiece] = useState(CALC_PIECES[0]!.key);
  const [quantity, setQuantity] = useState('1');
  const [hours, setHours] = useState(String(CALC_PIECES[0]!.hours).replace('.', ','));
  const [hourCents, setHourCents] = useState<number | null>(4000);
  const [materialCents, setMaterialCents] = useState<number | null>(65000);
  const [freightCents, setFreightCents] = useState<number | null>(0);
  const [profit, setProfit] = useState('30');
  const [card, setCard] = useState(false);
  const [cardPct, setCardPct] = useState('4');

  const r = calcPrice({
    quantity: num(quantity),
    hoursEach: num(hours),
    hourCents: hourCents ?? 0,
    materialCents: materialCents ?? 0,
    freightCents: freightCents ?? 0,
    profitPct: num(profit),
    card,
    cardPct: num(cardPct),
  });

  return (
    <div className="grid gap-8 lg:grid-cols-[7fr_5fr] lg:gap-12" data-testid="calculadora">
      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <FormGrid>
          <SelectField
            label="Peça"
            cols={8}
            value={piece}
            onChange={(e) => {
              const p = CALC_PIECES.find((x) => x.key === e.target.value)!;
              setPiece(p.key);
              setHours(String(p.hours).replace('.', ','));
            }}
          >
            {CALC_PIECES.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </SelectField>
          <NumberField
            label="Quantas peças"
            cols={4}
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          <NumberField
            label="Horas de trabalho por peça"
            cols={6}
            inputMode="decimal"
            step="0.5"
            min={0}
            hint="Desmontar, cortar, costurar, revestir e montar."
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <MoneyField
            label="Quanto vale a sua hora"
            cols={6}
            cents={hourCents}
            onCents={(v) => setHourCents(v)}
          />
          <MoneyField
            label="Material (tecido, espuma, cola, grampo)"
            cols={6}
            hint="Some tudo o que vai ser comprado para o serviço."
            cents={materialCents}
            onCents={(v) => setMaterialCents(v)}
          />
          <MoneyField
            label="Frete (retirada e entrega)"
            cols={6}
            cents={freightCents}
            onCents={(v) => setFreightCents(v)}
          />
          <NumberField
            label="Lucro que você quer (%)"
            cols={6}
            min={0}
            max={80}
            hint="Sobre o preço final."
            value={profit}
            onChange={(e) => setProfit(e.target.value)}
          />
          <div className="sm:col-span-6">
            <Checkbox
              label="Cliente vai pagar no cartão"
              description="A taxa da maquininha entra no preço."
              checked={card}
              onChange={(e) => setCard(e.target.checked)}
            />
            {card && (
              <div className="mt-3">
                <NumberField
                  label="Taxa da maquininha (%)"
                  inputMode="decimal"
                  min={0}
                  value={cardPct}
                  onChange={(e) => setCardPct(e.target.value)}
                />
              </div>
            )}
          </div>
        </FormGrid>
      </div>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-2xl border border-line bg-subtle/60 p-5 sm:p-6" aria-live="polite">
          <p className="text-sm font-semibold text-ink-soft">Preço para o cliente</p>
          {r.invalid ? (
            <p className="mt-2 text-[15px] text-danger-600" data-testid="calc-invalido">
              Lucro e taxa juntos passam de 90% do preço. Diminua o lucro.
            </p>
          ) : (
            <p
              className="mt-1 text-4xl font-semibold tracking-tight text-ink tabular-nums"
              data-testid="calc-preco"
            >
              {brl(r.priceCents)}
            </p>
          )}
          <div className="mt-4 divide-y divide-line border-t border-line text-[15px]">
            <SummaryRow label="Mão de obra" value={brl(r.laborCents)} />
            <SummaryRow label="Material e frete" value={brl(r.costCents - r.laborCents)} />
            <SummaryRow label="Custo do serviço" value={brl(r.costCents)} strong />
            {!r.invalid && <SummaryRow label="Seu lucro" value={brl(r.profitCents)} />}
            {!r.invalid && card && (
              <SummaryRow label="Taxa da maquininha" value={brl(r.cardCents)} />
            )}
          </div>
          <p className="mt-4 text-xs leading-5 text-ink-muted">
            Arredondado para cima, de R$ 10 em R$ 10. Nada do que você digita aqui é enviado ou
            guardado.
          </p>
        </div>
      </div>
    </div>
  );
}
