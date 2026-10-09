'use client';

import {
  LABOR_STATUS_LABEL,
  LOGISTICS_COST_KIND_LABEL,
  SPLIT_METHOD_LABEL,
  type ResultColumns,
} from '@cenario/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { Alert, Badge, Card, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useServiceOrders } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import {
  brDate,
  localToday,
  money,
  useFinSettings,
  useLogisticsCosts,
  useOrderResult,
  useOrderResults,
  type Period,
} from '@/lib/finance';
import { FormDialog, PAYMENT_OPTIONS, Table } from './common';

const SOURCE_LABEL: Record<string, string> = {
  COMPRA_EXCLUSIVA: 'Compra exclusiva recebida',
  ESTORNO_COMPRA: 'Estorno de recebimento',
  SAIDA_ESTOQUE: 'Saída do estoque',
  DEVOLUCAO_ESTOQUE: 'Devolução ao estoque',
  SOBRA_SAIDA: 'Sobra transferida (saída)',
  SOBRA_ENTRADA: 'Sobra recebida',
  AJUSTE_MANUAL: 'Lançamento manual',
};
const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('pt-BR')}%`);

/** Custos e resultado por OS (previsto × realizado) e custos logísticos com rateio. */
export function CostsTab({ period }: { period: Period }) {
  const can = useCan();
  const q = useOrderResults(period);
  const settings = useFinSettings();
  const logistics = useLogisticsCosts();
  const [open, setOpen] = useState<string | null>(null);
  const [tax, setTax] = useState(false);
  const [logi, setLogi] = useState(false);
  const [cancel, setCancel] = useState<{ id: string; version: number; code: string } | null>(null);
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="mr-auto text-lg font-semibold">Resultado por OS</h2>
          <span className="text-sm text-ink-muted" data-testid="tax-rate">
            Tributos estimados:{' '}
            {settings.data?.taxRateBps === null || settings.data === undefined
              ? 'não configurado'
              : `${(settings.data.taxRateBps / 100).toLocaleString('pt-BR')}% da receita`}
          </span>
          {can('financeiro.ajustes') && (
            <Button size="sm" variant="secondary" onClick={() => setTax(true)}>
              Alterar alíquota
            </Button>
          )}
        </div>
        <p className="mb-3 text-sm text-ink-muted">
          OS concluídas no período (todas as peças entregues) e em andamento. A margem de
          contribuição desconta materiais consumidos, mão de obra, logística, tributos estimados e
          outros custos variáveis — não é lucro líquido.
        </p>
        {q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <Alert tone="danger">{q.error.message}</Alert>
        ) : (
          <Table
            testId="fin-results"
            head={[
              'OS',
              'Cliente',
              'Situação',
              'Receita',
              'Custos (realizado)',
              'Margem (realizado)',
              'Margem (prevista)',
              '',
            ]}
          >
            {q.data.map((r) => (
              <tr key={r.serviceOrderId} data-testid={`result-${r.code}`}>
                <td className="px-4 py-2.5 font-mono font-semibold">{r.code}</td>
                <td className="px-4 py-2.5">{r.customer}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={r.delivered ? 'ok' : 'info'}>
                    {r.delivered ? 'Concluída' : 'Em andamento'}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{money(r.revenueCents)}</td>
                <td className="px-4 py-2.5 tabular-nums">{money(r.actual.variableCostsCents)}</td>
                <td className="px-4 py-2.5 font-semibold tabular-nums">
                  {money(r.actual.marginCents)}{' '}
                  <span className="text-xs text-ink-muted">{pct(r.actual.marginPct)}</span>
                </td>
                <td className="px-4 py-2.5 tabular-nums">
                  {money(r.forecast.marginCents)}{' '}
                  <span className="text-xs text-ink-muted">{pct(r.forecast.marginPct)}</span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button size="sm" variant="secondary" onClick={() => setOpen(r.serviceOrderId)}>
                    Detalhar
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center">
          <h2 className="mr-auto text-lg font-semibold">Custos logísticos</h2>
          {can('financeiro.gerenciar') && (
            <Button
              variant="secondary"
              icon={<Plus className="size-4" />}
              onClick={() => setLogi(true)}
            >
              Lançar custo logístico
            </Button>
          )}
        </div>
        {logistics.data && (
          <Table
            testId="fin-logistics"
            head={['Código', 'Data', 'Tipo', 'Descrição', 'Valor', 'Rateio', 'Conta a pagar', '']}
          >
            {logistics.data.map((c) => (
              <tr key={c.id} className={c.cancelled ? 'opacity-50' : undefined}>
                <td className="px-4 py-2.5 font-mono font-semibold">{c.code}</td>
                <td className="px-4 py-2.5">{brDate(c.date)}</td>
                <td className="px-4 py-2.5">{LOGISTICS_COST_KIND_LABEL[c.kind]}</td>
                <td className="px-4 py-2.5">
                  {c.description}
                  {c.beneficiary && <p className="text-xs text-ink-muted">{c.beneficiary}</p>}
                </td>
                <td className="px-4 py-2.5 tabular-nums">{money(c.amountCents)}</td>
                <td className="px-4 py-2.5 text-xs">
                  {SPLIT_METHOD_LABEL[c.splitMethod]}:{' '}
                  {c.allocations.map((a) => `${a.code} ${money(a.amountCents)}`).join(' · ')}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {c.cancelled ? 'Cancelado' : (c.payable?.code ?? '—')}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {can('financeiro.gerenciar') && !c.cancelled && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setCancel({ id: c.id, version: c.version, code: c.code })}
                    >
                      Cancelar
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {open && <ResultDialog id={open} onClose={() => setOpen(null)} />}
      {tax && (
        <FormDialog
          title="Alíquota de tributos estimados"
          description="Percentual sobre a receita usado só para estimar a margem (não é apuração fiscal). Vazio = não configurado."
          onClose={() => setTax(false)}
          fields={[
            {
              name: 'rate',
              label: 'Alíquota (%)',
              initial:
                settings.data?.taxRateBps === null || settings.data?.taxRateBps === undefined
                  ? ''
                  : String(settings.data.taxRateBps / 100).replace('.', ','),
            },
          ]}
          onSubmit={(v) => {
            const t = (v.rate ?? '').trim().replace(',', '.');
            const bps = t ? Math.round(Number(t) * 100) : null;
            if (bps !== null && (!Number.isFinite(bps) || bps < 0 || bps > 5000))
              return Promise.reject(new Error('Alíquota entre 0% e 50%.'));
            return api('/api/v1/finance/settings', { method: 'PUT', body: { taxRateBps: bps } });
          }}
        />
      )}
      {logi && <LogisticsDialog onClose={() => setLogi(false)} />}
      {cancel && (
        <FormDialog
          title={`Cancelar ${cancel.code}`}
          description="O custo sai de todas as OS do rateio; a conta a pagar ligada é cancelada se nada foi pago."
          onClose={() => setCancel(null)}
          fields={[{ name: 'reason', label: 'Motivo', type: 'textarea', required: true }]}
          onSubmit={(v, _c, key) =>
            api(`/api/v1/finance/logistics-costs/${cancel.id}/cancel`, {
              method: 'POST',
              body: { reason: v.reason, version: cancel.version },
              idempotencyKey: key,
            })
          }
        />
      )}
    </div>
  );
}

function Columns({ title, c }: { title: string; c: ResultColumns }) {
  const row = (label: string, v: number, strong = false) => (
    <div
      className={`flex justify-between ${strong ? 'border-t border-line pt-1 font-semibold' : ''}`}
    >
      <span>{label}</span>
      <span className="tabular-nums">{money(v)}</span>
    </div>
  );
  return (
    <Card className="space-y-1 p-4 text-sm">
      <h3 className="mb-1 font-semibold">{title}</h3>
      {row('Materiais', c.materialsCents)}
      {row('Mão de obra por produção', c.laborCents)}
      {row('Logística', c.logisticsCents)}
      {row('Tributos estimados', c.taxCents)}
      {row('Outros variáveis', c.otherVariableCents)}
      {row('Margem de contribuição', c.marginCents, true)}
      <p className="text-right text-xs text-ink-muted">{pct(c.marginPct)} da receita</p>
    </Card>
  );
}

function ResultDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const q = useOrderResult(id);
  const [cost, setCost] = useState(false);
  const r = q.data;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={r ? `Resultado — ${r.code} (${r.customer})` : 'Resultado da OS'}
    >
      {!r ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-sm" data-testid="result-detail">
          <p>
            Receita atribuída: <strong>{money(r.revenueCents)}</strong>
            {r.completedAt ? ` · concluída em ${brDate(r.completedAt)}` : ' · em andamento'}
          </p>
          {r.warnings.map((w) => (
            <Alert key={w} tone="warn">
              {w}
            </Alert>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <Columns title="Previsto (estimativa)" c={r.forecast} />
            <Columns title="Realizado (registrado)" c={r.actual} />
          </div>
          {r.fixedTeamEstimateCents !== null && (
            <p className="text-ink-muted">
              Equipe fixa alocada por tempo (estimativa, fora da margem de contribuição):{' '}
              {money(r.fixedTeamEstimateCents)}
            </p>
          )}
          <div>
            <h3 className="mb-1 font-semibold">Materiais</h3>
            <p className="mb-2 text-ink-muted">
              Previsto {money(r.materials.forecastCents)} · comprado{' '}
              {money(r.materials.purchasedCents)} · reservado {money(r.materials.reservedCents)} ·
              consumido/destinado <strong>{money(r.materials.consumedCents)}</strong>
            </p>
            {r.materials.lines.length > 0 && (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {r.materials.lines.map((l) => (
                  <li key={l.id} className="flex flex-wrap gap-3 px-3 py-1.5">
                    <span className="w-24">{brDate(l.occurredAt)}</span>
                    <span className="flex-1">
                      {SOURCE_LABEL[l.source] ?? l.source}: {l.description}
                      {l.quantity !== null ? ` · ${l.quantity.toLocaleString('pt-BR')}` : ''}
                      {!l.priced ? ' · sem preço' : ''}
                      {l.note ? ` · ${l.note}` : ''}
                    </span>
                    <span className="tabular-nums">{money(l.amountCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-1 font-semibold">Mão de obra e logística</h3>
            <ul className="space-y-1">
              {r.labor.map((l) => (
                <li key={l.id}>
                  {l.code} · {l.professional.displayName} · {l.piece?.code ?? 'OS inteira'} ·{' '}
                  {money(l.dueCents)} · {LABOR_STATUS_LABEL[l.status]}
                </li>
              ))}
              {r.logistics.map((l) => (
                <li key={l.id}>
                  {l.code} · {LOGISTICS_COST_KIND_LABEL[l.kind]} · {l.description} ·{' '}
                  {money(l.amountCents)}
                </li>
              ))}
            </ul>
          </div>
          {can('financeiro.ajustes') && (
            <Button size="sm" variant="secondary" onClick={() => setCost(true)}>
              Lançar custo manual
            </Button>
          )}
        </div>
      )}
      {r && cost && (
        <FormDialog
          title={`Lançar custo — ${r.code}`}
          description="Para material sem preço conhecido ou outro custo variável (ex.: taxa de cartão). Use valor negativo para corrigir. Fica no histórico com justificativa."
          onClose={() => setCost(false)}
          fields={[
            {
              name: 'category',
              label: 'Categoria',
              type: 'select',
              options: [
                { value: 'OUTRO_VARIAVEL', label: 'Outro custo variável' },
                { value: 'MATERIAL', label: 'Material' },
              ],
            },
            { name: 'description', label: 'Descrição', required: true },
            { name: 'amount', label: 'Valor (R$)', type: 'money', required: true },
            { name: 'reason', label: 'Justificativa', type: 'textarea', required: true },
          ]}
          onSubmit={(v, cents, key) =>
            api('/api/v1/finance/costs', {
              method: 'POST',
              body: {
                serviceOrderId: r.serviceOrderId,
                category: v.category,
                description: v.description,
                amountCents: cents('amount'),
                reason: v.reason,
              },
              idempotencyKey: key,
            })
          }
        />
      )}
    </Dialog>
  );
}

function LogisticsDialog({ onClose }: { onClose: () => void }) {
  const sos = useServiceOrders({ status: 'ABERTA' });
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <FormDialog
      title="Lançar custo logístico"
      description="Uma viagem que atende várias OS é lançada uma vez e rateada (a soma do rateio é sempre o total)."
      onClose={onClose}
      fields={[
        {
          name: 'kind',
          label: 'Tipo',
          type: 'select',
          options: PAYMENT_OPTIONS(LOGISTICS_COST_KIND_LABEL),
        },
        { name: 'description', label: 'Descrição', required: true },
        { name: 'amount', label: 'Valor total (R$)', type: 'money', required: true },
        { name: 'date', label: 'Data', type: 'date', required: true, initial: localToday() },
        {
          name: 'split',
          label: 'Rateio',
          type: 'select',
          options: PAYMENT_OPTIONS({
            IGUAL: SPLIT_METHOD_LABEL.IGUAL,
            POR_PECA: SPLIT_METHOD_LABEL.POR_PECA,
          }),
        },
        {
          name: 'beneficiary',
          label: 'Beneficiário (transportador)',
          hint: 'Obrigatório para gerar a conta a pagar.',
        },
        { name: 'dueDate', label: 'Vencimento da conta a pagar (opcional)', type: 'date' },
        { name: 'note', label: 'Observação do rateio', type: 'textarea' },
      ]}
      onSubmit={(v, cents, key) => {
        if (!chosen.length) return Promise.reject(new Error('Escolha as OS atendidas.'));
        return api('/api/v1/finance/logistics-costs', {
          method: 'POST',
          body: {
            kind: v.kind,
            description: v.description,
            amountCents: cents('amount'),
            date: v.date,
            beneficiary: v.beneficiary || null,
            splitMethod: v.split,
            splitNote: v.note || null,
            allocations: chosen.map((serviceOrderId) => ({ serviceOrderId })),
            payableDueDate: v.dueDate || null,
          },
          idempotencyKey: key,
        });
      }}
    >
      <fieldset className="mb-3">
        <legend className="label">OS atendidas</legend>
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
          {(sos.data?.items ?? []).map((s) => (
            <Checkbox
              key={s.id}
              label={`${s.code} — ${s.customer.name}`}
              checked={chosen.includes(s.id)}
              onChange={(e) =>
                setChosen((c) => (e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id)))
              }
            />
          ))}
        </div>
      </fieldset>
    </FormDialog>
  );
}
