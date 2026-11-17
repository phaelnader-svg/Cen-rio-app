'use client';

import { pluralWord } from '@cenario/shared';
import {
  QUOTE_CONTRACT_CLAUSES,
  formatCents,
  type QuoteSnapshot,
  type QuoteWorkOrder,
} from '@cenario/shared';
import clsx from 'clsx';
import { ImageIcon } from 'lucide-react';
import { qtyText } from '@/lib/quotes';

/**
 * Documentos do orçamento no visual do painel: proposta comercial, contrato de garantia e a O.S.
 * do orçamento (execução + ordem de compra). Mesmos tokens de cor, tipografia e cartões do sistema.
 */

const dateBr = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
const dayBr = (day: string) =>
  day ? new Date(`${day}T12:00:00`).toLocaleDateString('pt-BR') : '—';

function Eyebrow({ children, light }: { children: React.ReactNode; light?: boolean }) {
  return (
    <p
      className={clsx(
        'text-[11px] font-semibold tracking-[0.12em] uppercase',
        light ? 'text-brand-100' : 'text-ink-muted',
      )}
    >
      {children}
    </p>
  );
}

function Logo({ src, className }: { src: string | null; className?: string }) {
  if (!src || !/^data:image\/(png|jpeg);base64,/.test(src)) return null;
  // Logotipo da empresa em data URL (gravado no orçamento).
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="Logotipo da empresa" className={clsx('object-contain', className)} />;
}

function DocHeader({
  company,
  logo,
  kicker,
  title,
  description,
}: {
  company: string;
  logo: string | null;
  kicker: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="bg-brand-700 px-6 py-6 text-white sm:px-8 print:py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{company}</p>
          <Eyebrow light>{kicker}</Eyebrow>
        </div>
        <Logo src={logo} className="max-h-14 max-w-24 rounded-lg bg-white p-1.5" />
      </div>
      <div className="mt-5 border-t border-white/20 pt-5 print:mt-2 print:pt-2">
        <h2 className="text-2xl font-semibold tracking-tight print:text-xl">{title}</h2>
        {description && (
          <p className="mt-1 max-w-xl text-[15px] text-brand-100 print:text-sm">{description}</p>
        )}
      </div>
    </div>
  );
}

/** Proposta comercial para o cliente. */
export function ProposalDocument({
  s,
  number,
  pendingWarning,
}: {
  s: QuoteSnapshot;
  number?: number;
  pendingWarning?: boolean;
}) {
  const t = s.totals;
  const firstName = s.customerName.trim().split(/\s+/)[0];
  const fee = s.fee;
  const installments = fee && fee.installments > 1 ? fee.installments : 0;
  return (
    <article className="print-page print-flat overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]">
      <DocHeader
        company={s.companyName}
        logo={s.logoDataUrl}
        kicker="Proposta de serviços • Tapeçaria"
        title="Uma nova vida para o seu estofado."
        description="Preparamos esta proposta com cuidado, pensando no conforto, na beleza e na renovação do seu ambiente."
      />
      <div className="space-y-5 px-6 py-6 sm:px-8 print:space-y-2.5 print:py-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Eyebrow>Proposta preparada para</Eyebrow>
            <p className="mt-1 text-xl font-semibold">{s.customerName || '—'}</p>
            <p className="mt-0.5 text-sm text-ink-muted">
              {[s.city, s.phone].filter(Boolean).join(' • ') || '—'}
            </p>
          </div>
          <div className="text-right">
            <Eyebrow>Emissão</Eyebrow>
            <p className="mt-1 font-semibold tabular-nums">{dateBr(s.issuedAt)}</p>
            {number !== undefined && (
              <p className="text-sm text-ink-muted tabular-nums">Orçamento nº {number}</p>
            )}
          </div>
        </div>

        <div className="text-[15px] text-ink-soft print:text-sm">
          <p className="font-medium text-ink">{firstName ? `Olá, ${firstName}!` : 'Olá!'}</p>
          <p className="mt-1">
            Será um prazer cuidar do seu estofado. Abaixo, você encontra os detalhes do serviço e as
            condições que preparamos para você.
          </p>
        </div>

        {/* Na folha impressa, serviço e valor ficam lado a lado para a proposta caber numa folha só. */}
        <div className="space-y-5 print:grid print:grid-cols-2 print:gap-3 print:space-y-0">
          <section className="rounded-xl border border-line p-5 print:p-4">
            <Eyebrow>O que vamos realizar</Eyebrow>
            <p className="mt-1 text-lg font-semibold">{s.service || '—'}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              {(
                [
                  ['Espuma', s.foamChange],
                  ['Tecido', s.fabricChange],
                ] as const
              ).map(([n, v]) => (
                <span
                  key={n}
                  className="rounded-full bg-subtle px-3 py-1 font-medium text-ink-soft ring-1 ring-line ring-inset"
                >
                  {n}: {v ? 'troca incluída' : 'sem troca'}
                </span>
              ))}
            </div>
            {s.fabrics.length > 0 && (
              <p className="mt-3 text-sm text-ink-soft">
                <strong className="text-ink">
                  {s.fabrics.length === 1 ? 'Tecido selecionado: ' : 'Tecidos selecionados: '}
                </strong>
                {s.fabrics.join(', ')}
              </p>
            )}
          </section>

          <section className="rounded-xl bg-brand-50 p-5 ring-1 ring-brand-100 ring-inset print:p-4">
            <Eyebrow>Investimento para o seu projeto</Eyebrow>
            <p className="mt-2 text-sm text-ink-soft">Valor à vista</p>
            <p className="money text-3xl font-semibold text-brand-700 print:text-2xl">
              {formatCents(t.totalCents)}
            </p>
            {fee && t.installmentTotalCents !== null && (
              <div className="mt-3 rounded-lg bg-surface px-4 py-3 ring-1 ring-line ring-inset">
                <p className="text-xs text-ink-muted">Opção de pagamento</p>
                <p className="font-semibold">
                  {fee.name}: <span className="money">{formatCents(t.installmentTotalCents)}</span>
                  {installments > 0 && (
                    <span className="money font-normal text-ink-soft">
                      {' '}
                      ({installments}x de{' '}
                      {formatCents(Math.round(t.installmentTotalCents / installments))})
                    </span>
                  )}
                </p>
              </div>
            )}
            <p className="mt-3 text-xs text-ink-muted">
              Os valores apresentados contemplam o serviço descrito nesta proposta.
            </p>
          </section>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-[2fr_3fr] print:gap-3">
          <section className="rounded-xl border border-line p-5 print:p-4">
            <Eyebrow>Condições comerciais</Eyebrow>
            <p className="mt-1 font-semibold print:text-sm">Como funciona o pagamento</p>
            <p className="mt-2 text-sm whitespace-pre-line text-ink-soft print:text-xs">
              {s.paymentTerms || '—'}
            </p>
            <p className="mt-3 text-sm font-medium">
              Prazo de entrega:{' '}
              {s.deliveryDays ? `${s.deliveryDays} dias úteis` : 'a definir na contratação'}
            </p>
            <p className="text-sm font-medium">
              Validade da proposta: {s.validityDays ?? '—'} dias
            </p>
          </section>
          <section className="rounded-xl border border-line p-5 print:p-4">
            <Eyebrow>Informações importantes</Eyebrow>
            <p className="mt-1 font-semibold print:text-sm">Observações</p>
            <p className="mt-2 text-sm whitespace-pre-line text-ink-soft print:text-xs">
              {s.notes || '—'}
            </p>
          </section>
        </div>

        <section className="print-keep border-l-4 border-bronze-500 pl-4 print:text-xs">
          <p className="font-semibold">Obrigado pela confiança!</p>
          <p className="mt-1 text-sm text-ink-soft print:mt-0.5 print:text-xs">
            Queremos que cada detalhe do resultado faça a diferença no seu dia a dia. Ficamos à
            disposição para esclarecer dúvidas e conversar sobre os próximos passos.
          </p>
          <p className="mt-2 text-sm font-semibold print:mt-0.5 print:text-xs">
            Será um prazer realizar esse projeto para você.
          </p>
        </section>

        {pendingWarning && (
          <p className="text-sm font-semibold text-warn-600">
            ATENÇÃO: valores pendentes. Proposta não finalizada.
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4 text-xs text-ink-muted print:hidden">
          <span>{s.companyName}</span>
          <span>Proposta comercial • Preparada especialmente para você</span>
        </div>
      </div>
    </article>
  );
}

/** Contrato de garantia e responsabilidades (duas folhas), anexo à proposta salva. */
export function ContractDocument({ s, number }: { s: QuoteSnapshot; number: number }) {
  const page = (kicker: string, body: React.ReactNode) => (
    <article className="print-page print-flat overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-4 bg-brand-700 px-6 py-4 text-white sm:px-8">
        <div className="min-w-0">
          <p className="truncate font-semibold">{s.companyName}</p>
          <Eyebrow light>{kicker}</Eyebrow>
        </div>
        <Logo src={s.logoDataUrl} className="max-h-12 max-w-20 rounded-md bg-white p-1" />
      </div>
      <div className="space-y-3 px-6 py-6 text-sm sm:px-8 print:space-y-2 print:py-4 print:text-xs">
        {body}
      </div>
    </article>
  );
  const clauses = (from: number, to: number) =>
    QUOTE_CONTRACT_CLAUSES.slice(from, to).map(([title, text]) => (
      <section key={title}>
        <h4 className="font-semibold text-brand-700">{title}</h4>
        <p className="mt-0.5 text-justify text-ink-soft">{text}</p>
      </section>
    ));
  return (
    <div className="space-y-6">
      {page(
        'Contrato • Garantia e responsabilidades',
        <>
          <h3 className="text-lg font-semibold text-brand-700">
            Garantia dos serviços e responsabilidades
          </h3>
          <div className="rounded-lg bg-subtle px-4 py-3">
            <p className="font-semibold tabular-nums">Orçamento nº {number}</p>
            <p className="text-ink-soft">
              Contratante: {s.customerName || '—'} • Serviço: {s.service || '—'}
            </p>
          </div>
          {clauses(0, 6)}
        </>,
      )}
      {page(
        'Contrato • Continuação e assinaturas',
        <>
          {clauses(6, 9)}
          <section className="pt-2">
            <h4 className="font-semibold text-brand-700">Declaração de ciência e concordância</h4>
            <p className="mt-0.5 text-justify text-ink-soft">
              A CONTRATADA e o CONTRATANTE declaram que leram, compreenderam e estão de acordo com
              todas as informações, condições, responsabilidades, limitações e orientações
              estabelecidas neste contrato, comprometendo-se a respeitar os termos aqui
              apresentados.
            </p>
            <p className="mt-1 text-ink-soft">
              Por estarem de pleno acordo, firmam o presente documento mediante suas assinaturas.
            </p>
          </section>
          <div className="print-keep">
            <p className="pt-4">Local e data: _______________________________________________</p>
            <div className="grid grid-cols-2 gap-8 pt-10 text-center">
              <div className="border-t border-ink-soft pt-2">
                <p className="font-semibold">CONTRATADA</p>
                <p className="text-ink-soft">{s.companyName}</p>
              </div>
              <div className="border-t border-ink-soft pt-2">
                <p className="font-semibold">CONTRATANTE</p>
                <p className="text-ink-soft">{s.customerName}</p>
              </div>
            </div>
          </div>
        </>,
      )}
    </div>
  );
}

function KeyValue({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="table-wrap rounded-xl border border-line">
      <table className="data-table data-table-compact">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="w-1/2 text-ink-soft">{k}</td>
              <td className="font-medium">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** O.S. do orçamento: folha de execução e folha de compra de materiais (documento interno). */
export function WorkOrderDocument({
  s,
  number,
  customerName,
  service,
  wo,
}: {
  s: QuoteSnapshot;
  number: number;
  customerName: string;
  service: string;
  wo: QuoteWorkOrder;
}) {
  const meta = (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <Eyebrow>Cliente</Eyebrow>
        <p className="mt-1 text-lg font-semibold">{customerName}</p>
        <p className="text-sm text-ink-soft">
          <strong className="text-ink">Serviço:</strong> {service}
        </p>
      </div>
      <div className="text-right">
        <Eyebrow>Data da OS</Eyebrow>
        <p className="mt-1 font-semibold tabular-nums">{dayBr(wo.date)}</p>
        <p className="text-sm text-ink-muted tabular-nums">Orçamento nº {number}</p>
      </div>
    </div>
  );
  const fabricRows: [string, React.ReactNode][] = [
    ['Nome do tecido', wo.fabricName || 'Não informado'],
    ['Metragem', wo.fabricMeters !== null ? `${qtyText(wo.fabricMeters, 2)} m` : 'Não informada'],
  ];
  const materialsTotal = wo.items.reduce((a, x) => a + x.costCents, 0);
  const photo =
    wo.photoDataUrl && /^data:image\/(png|jpeg);base64,/.test(wo.photoDataUrl)
      ? wo.photoDataUrl
      : null;
  return (
    <div className="space-y-6">
      <article className="print-page print-flat overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]">
        <DocHeader
          company={s.companyName}
          logo={s.logoDataUrl}
          kicker="Ordem de serviço • Tapeçaria"
          title="Ordem de Serviço"
          description="Controle interno de execução: informações do serviço e mão de obra."
        />
        <div className="space-y-5 px-6 py-6 sm:px-8">
          <div className="grid gap-5 sm:grid-cols-[1fr_14rem]">
            <div className="space-y-4">
              {meta}
              <div>
                <p className="font-semibold">Responsável pela execução</p>
                <p className="text-sm text-ink-soft">
                  <strong className="text-ink">Tapeceiro:</strong>{' '}
                  {wo.responsibleName || 'Não selecionado'}
                </p>
              </div>
            </div>
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photo}
                alt="Foto do serviço"
                className="max-h-64 w-full rounded-xl border border-line object-cover"
              />
            ) : (
              <div className="grid h-40 place-items-center rounded-xl border border-dashed border-line-strong text-sm text-ink-muted">
                <span className="flex items-center gap-2">
                  <ImageIcon className="size-4" aria-hidden /> Foto do serviço
                </span>
              </div>
            )}
          </div>
          <div>
            <p className="mb-2 font-semibold">Mão de obra do tapeceiro</p>
            <KeyValue
              rows={[
                [
                  'Valor real da mão de obra',
                  <span key="v" className="money">
                    {formatCents(wo.upholsteryCents)}
                  </span>,
                ],
              ]}
            />
          </div>
          <div>
            <p className="mb-2 font-semibold">Tecido escolhido</p>
            <KeyValue rows={fabricRows} />
          </div>
          <div>
            <p className="mb-2 font-semibold">Informações da execução</p>
            <KeyValue
              rows={[
                ['Manter original', wo.keepOriginal],
                ['Trocar espumas', wo.changeFoam],
                ['Trocar tecido', wo.changeFabric],
                ['Reparar estrutura', wo.repairStructure],
              ]}
            />
          </div>
          {wo.notes && (
            <div>
              <p className="font-semibold">Observações internas</p>
              <p className="mt-1 text-sm whitespace-pre-wrap text-ink-soft">{wo.notes}</p>
            </div>
          )}
          <p className="text-xs text-ink-muted">Documento interno de controle da execução.</p>
        </div>
      </article>

      <article className="print-page print-flat overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]">
        <DocHeader
          company={s.companyName}
          logo={s.logoDataUrl}
          kicker="Ordem de compra • Materiais"
          title="Materiais previstos no orçamento"
          description="Relação para conferência e compra de materiais."
        />
        <div className="space-y-5 px-6 py-6 sm:px-8">
          {meta}
          <div>
            <p className="mb-2 font-semibold">Tecido escolhido para o serviço</p>
            <KeyValue rows={fabricRows} />
          </div>
          <div>
            <p className="mb-2 font-semibold">Materiais para compra</p>
            <div className="table-wrap rounded-xl border border-line">
              <table className="data-table data-table-compact">
                <thead>
                  <tr>
                    <th>Descrição / especificações</th>
                    <th className="num">Quantidade</th>
                    <th className="num">Custo previsto</th>
                  </tr>
                </thead>
                <tbody>
                  {wo.items.length === 0 && (
                    <tr>
                      <td colSpan={3} className="text-ink-muted">
                        Nenhum material registrado neste orçamento.
                      </td>
                    </tr>
                  )}
                  {wo.items.map((x, i) => (
                    <tr key={i}>
                      <td>
                        {x.category} — {x.name}
                        {x.category === 'Espumas' && (
                          <span className="block text-xs text-ink-muted">
                            {qtyText(x.heightCm)} × {qtyText(x.widthCm)} × {qtyText(x.lengthCm)} cm
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {qtyText(x.realQty)}{' '}
                        {x.category === 'Espumas' ? pluralWord(x.realQty, 'peça', 'peças') : x.unit}
                      </td>
                      <td className="num">{formatCents(x.costCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>Total de materiais</td>
                    <td className="num">{formatCents(materialsTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <p className="text-xs text-ink-muted">
            Documento interno para compra de materiais. Valores conforme dados registrados na OS;
            conferir quantidades antes da aquisição.
          </p>
        </div>
      </article>
    </div>
  );
}
