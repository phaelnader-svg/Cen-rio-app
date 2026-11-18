'use client';

import {
  QUOTE_LOST_REASONS,
  QUOTE_STATUSES,
  QUOTE_STATUS_LABEL,
  formatCents,
  whatsappLink,
  type QuoteDto,
  type QuoteFunnelDto,
  type QuoteStatus,
  type QuoteSummaryDto,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DateField, FormGrid, SelectField, TextField } from '@/components/ui/form';
import { Alert, Badge, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { localDay, useSavedQuote } from '@/lib/quotes';

const STATUS_TONE: Record<QuoteStatus, 'info' | 'ok' | 'danger' | 'neutral'> = {
  ENVIADO: 'info',
  APROVADO: 'ok',
  RECUSADO: 'danger',
  SEM_RESPOSTA: 'neutral',
};

const brDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

/** Melhoria 77: situação do orçamento, com o lembrete de cobrar quando já venceu. */
export function QuoteStatusBadges({ q }: { q: QuoteSummaryDto }) {
  return (
    <>
      <Badge tone={STATUS_TONE[q.status]} className="ml-1 align-middle">
        {QUOTE_STATUS_LABEL[q.status]}
        {q.status === 'APROVADO' && q.approvedVia === 'LINK' ? ' pelo link' : ''}
      </Badge>
      {q.followUpDue && (
        <Badge tone="warn" className="ml-1 align-middle">
          Cobrar o cliente
        </Badge>
      )}
      {q.orderId && (
        <Badge tone="brand" className="ml-1 align-middle">
          Virou pedido
        </Badge>
      )}
    </>
  );
}

/** Linha de detalhes da situação (quando mudou, motivo da recusa, lembrete, link aberto). */
export function quoteStatusLine(q: QuoteSummaryDto): string {
  const parts: string[] = [];
  if (q.status === 'APROVADO' && q.approvedAt) parts.push(`Aprovado em ${brDate(q.approvedAt)}`);
  if (q.status === 'RECUSADO' && q.lostReason) parts.push(`Motivo: ${q.lostReason}`);
  if (q.status === 'ENVIADO' && q.followUpAt) parts.push(`Cobrar em ${brDate(q.followUpAt)}`);
  if (q.pickupDate && !q.orderId)
    parts.push(
      `Cliente quer a retirada em ${q.pickupDate.split('-').reverse().join('/')}, ${q.pickupShift === 'MANHA' ? 'de manhã' : 'à tarde'}`,
    );
  if (q.linkViewedAt) parts.push(`Cliente abriu o link em ${brDate(q.linkViewedAt)}`);
  return parts.join(' • ');
}

/** Melhoria 79: link da proposta para o cliente aprovar pelo celular. */
export function QuoteLinkButtons({ q }: { q: QuoteSummaryDto }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const getUrl = async () => {
    setBusy(true);
    try {
      return (await api<{ url: string }>(`/api/v1/quotes/${q.id}/link`)).url;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        icon={<Copy className="size-4" aria-hidden />}
        onClick={async () => {
          try {
            const url = await getUrl();
            await navigator.clipboard.writeText(url);
            toast('ok', 'Link da proposta copiado. Cole na conversa com o cliente.');
          } catch (e) {
            toast('danger', errorMessage(e));
          }
        }}
      >
        Copiar link
      </Button>
      {q.phone && (
        <Button
          size="sm"
          variant="secondary"
          icon={<MessageCircle className="size-4" aria-hidden />}
          onClick={async () => {
            // Abre a janela antes da chamada (o navegador bloqueia janelas abertas depois de await).
            const win = window.open('', '_blank');
            try {
              const url = await getUrl();
              const text = `Olá, ${q.customerName.split(' ')[0]}! Segue a proposta nº ${q.number} (${formatCents(q.totalCents)}). Pelo link você confere tudo e pode aprovar: ${url}`;
              const wa = whatsappLink(q.phone ?? '', text);
              if (win && wa) win.location.href = wa;
              else win?.close();
            } catch (e) {
              win?.close();
              toast('danger', errorMessage(e));
            }
          }}
        >
          Enviar no WhatsApp
        </Button>
      )}
    </>
  );
}

/** Melhoria 77: mudar a situação, registrar o motivo da recusa e a data do lembrete. */
export function QuoteStatusDialog({
  summary,
  onClose,
}: {
  summary: QuoteSummaryDto | null;
  onClose: () => void;
}) {
  const q = useSavedQuote(summary?.id ?? null);
  return (
    <Dialog
      open={Boolean(summary)}
      onClose={onClose}
      title="Situação do orçamento"
      description={summary ? `Nº ${summary.number} — ${summary.customerName}` : undefined}
      size="sm"
    >
      {!summary ? null : q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <StatusForm key={`${q.data.id}:${q.data.version}`} quote={q.data} onClose={onClose} />
      )}
    </Dialog>
  );
}

function StatusForm({ quote, onClose }: { quote: QuoteDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<QuoteStatus>(quote.status);
  const known = (QUOTE_LOST_REASONS as readonly string[]).includes(quote.lostReason ?? '');
  const [reason, setReason] = useState(
    quote.lostReason ? (known ? quote.lostReason : 'Outro') : '',
  );
  const [other, setOther] = useState(quote.lostReason && !known ? quote.lostReason : '');
  const [followUp, setFollowUp] = useState(quote.followUpAt ? localDay(quote.followUpAt) : '');
  const save = useMutation({
    mutationFn: () =>
      api<QuoteDto>(`/api/v1/quotes/${quote.id}/status`, {
        method: 'POST',
        body: {
          version: quote.version,
          status,
          lostReason: status === 'RECUSADO' ? (reason === 'Outro' ? other.trim() : reason) : null,
          ...(status === 'ENVIADO' ? { followUpDate: followUp || null } : {}),
        },
      }),
    onSuccess: async () => {
      toast('ok', 'Situação do orçamento atualizada.');
      await qc.invalidateQueries({ queryKey: ['quotes'] });
      onClose();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <FormGrid>
        <SelectField
          label="Situação"
          cols={12}
          value={status}
          onChange={(e) => setStatus(e.target.value as QuoteStatus)}
        >
          {QUOTE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {QUOTE_STATUS_LABEL[s]}
            </option>
          ))}
        </SelectField>
        {status === 'RECUSADO' && (
          <SelectField
            label="Por que o cliente não fechou?"
            cols={12}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">Selecione o motivo</option>
            {QUOTE_LOST_REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
            <option>Outro</option>
          </SelectField>
        )}
        {status === 'RECUSADO' && reason === 'Outro' && (
          <TextField
            label="Qual o motivo?"
            cols={12}
            maxLength={300}
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
        )}
        {status === 'ENVIADO' && (
          <DateField
            label="Lembrar de cobrar o cliente em"
            cols={12}
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            hint="Deixe em branco para não lembrar."
          />
        )}
      </FormGrid>
      {save.error && (
        <Alert tone="danger" className="mt-3">
          {errorMessage(save.error)}
        </Alert>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          type="submit"
          loading={save.isPending}
          disabled={status === 'RECUSADO' && !(reason === 'Outro' ? other.trim() : reason)}
        >
          Salvar
        </Button>
      </div>
    </form>
  );
}

const firstOfMonth = () => {
  const d = new Date();
  return localDay(new Date(d.getFullYear(), d.getMonth(), 1));
};

/** Melhoria 81: funil de vendas do período. */
export function QuoteFunnel() {
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(() => localDay(new Date()));
  const valid = Boolean(from && to && from <= to);
  const funnel = useQuery({
    queryKey: ['quotes', 'funnel', from, to],
    queryFn: () => api<QuoteFunnelDto>(`/api/v1/quotes/funnel?from=${from}&to=${to}`),
    enabled: valid,
  });
  const f = funnel.data;
  const steps: { label: string; count: number; cents: number }[] = f
    ? [
        { label: 'Orçamentos feitos', ...f.total },
        { label: 'Aprovados', ...f.byStatus.APROVADO },
        { label: 'Viraram pedido', ...f.converted },
      ]
    : [];
  const max = Math.max(1, f?.total.count ?? 1);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold">Funil de vendas</h2>
          <p className="text-sm text-ink-muted">
            De cada orçamento feito no período, quantos foram aprovados e viraram pedido.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DateField label="De" value={from} onChange={(e) => setFrom(e.target.value)} />
          <DateField label="Até" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      {!valid ? (
        <Alert tone="danger" className="mt-3">
          A data de início não pode ser posterior à data de término.
        </Alert>
      ) : funnel.isPending ? (
        <Spinner className="mt-4" />
      ) : funnel.isError ? (
        <Alert tone="danger" className="mt-3">
          {funnel.error.message}
        </Alert>
      ) : (
        f && (
          <div className="mt-4 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <div className="space-y-2.5">
              {steps.map((s) => (
                <div key={s.label}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">{s.label}</span>
                    <span className="tabular-nums text-ink-soft">
                      {s.count} • <span className="money">{formatCents(s.cents)}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2.5 rounded-full bg-subtle">
                    <div
                      className="h-2.5 rounded-full bg-brand-600"
                      style={{ width: `${Math.round((s.count / max) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="pt-1 text-sm text-ink-muted">
                {f.approvalRateBps === null
                  ? 'Ainda não há orçamentos respondidos no período.'
                  : `Taxa de aprovação: ${(f.approvalRateBps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% dos orçamentos respondidos.`}{' '}
                {f.byStatus.ENVIADO.count} aguardando resposta
                {f.followUpDue ? `, ${f.followUpDue} para cobrar hoje` : ''}.
              </p>
            </div>
            <div>
              <p className="label">Por que não fecharam</p>
              {f.lostReasons.length ? (
                <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                  {f.lostReasons.map((r) => (
                    <li key={r.reason} className="flex justify-between gap-3 px-3 py-2">
                      <span>{r.reason}</span>
                      <span className="tabular-nums text-ink-soft">
                        {r.count} • <span className="money">{formatCents(r.cents)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">Nenhum orçamento recusado no período.</p>
              )}
            </div>
          </div>
        )
      )}
    </Card>
  );
}
