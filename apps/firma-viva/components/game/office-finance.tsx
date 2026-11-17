'use client';
/**
 * Escritório financeiro: ficha do sofá (orçamento → contrato → entrada → saldo → nota →
 * materiais → retirada → entrega) e painel do financeiro (hoje, pagar, banco, fechamento,
 * fiscal, entregas). Enviar contrato, emitir cobrança/nota e confirmar pagamento sempre passam
 * por uma tela de revisão com o que vai acontecer.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { GBtn, Panel, Section, Tone } from './ui';

const brl = (c: number | null | undefined) =>
  ((c ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';
type ToneKey = 'ok' | 'atencao' | 'risco' | 'info' | 'neutro';
const toneOf = (t: ToneKey) => (t === 'neutro' ? 'info' : t);

interface Step {
  key: string;
  label: string;
  state: string;
  tone: ToneKey;
  detail: string;
  ref?: Record<string, unknown>;
}
interface Ficha {
  serviceOrderId: string;
  osCode: string;
  orderId: string;
  orderCode: string;
  customer: string;
  finalCents: number | null;
  receivedCents: number;
  balanceCents: number | null;
  steps: Step[];
}
interface ContractRow {
  id: string;
  revision: number;
  body: string;
  status: string;
  signers: { name: string; email: string; phone?: string | null; role: string }[];
  provider: string | null;
  sentAt: string | null;
  signedAt: string | null;
  signedFileUrl: string | null;
  version: number;
  missing: string[];
}
interface ChargeRow {
  id: string;
  billingType: string;
  amountCents: number;
  dueDate: string;
  status: string;
  pixPayload: string | null;
  paymentUrl: string | null;
  provider: string;
  baixada: boolean;
  version: number;
}
interface RecRow {
  id: string;
  description: string;
  amountCents: number;
  receivedCents: number;
  status: string;
  dueTrigger: string;
  dueDate: string | null;
  charges: ChargeRow[];
}
interface Preview {
  finalCents: number;
  billedCents: number;
  remainingCents: number;
  lines: {
    description: string;
    amountCents: number;
    dueTrigger: string;
    dueDate: string | null;
    emitNow: boolean;
    billingType: string;
    installments: number | null;
  }[];
  provider: { label: string; test: boolean } | null;
}
interface FiscalRow {
  id: string;
  status: string;
  description: string;
  amountCents: number;
  number: string | null;
  files: { name: string; url: string }[];
  profile: { name: string };
  missing: string[];
  version: number;
  rejectionReason: string | null;
}

function useAct() {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(
    path: string,
    body: unknown = {},
    ok?: string,
    method: 'POST' | 'PUT' = 'POST',
  ): Promise<T | null> => {
    try {
      const r = await api<T>(path, { method, idempotencyKey: newIdempotencyKey(), body });
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('office') });
      if (ok) toast('ok', ok);
      return r;
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível concluir.');
      return null;
    }
  };
}

// ─────────────────────────────── Ficha do sofá ───────────────────────────────

export function FichaPanel({
  soId,
  focus,
  onClose,
  canFin,
  canDocs,
  canBuy,
}: {
  soId: string;
  focus: string | null;
  onClose: () => void;
  canFin: boolean;
  canDocs: boolean;
  canBuy: boolean;
}) {
  const ficha = useQuery({
    queryKey: ['office-ficha', soId],
    queryFn: () => api<Ficha>(`/api/v1/office/service-orders/${soId}/ficha`),
  });
  const f = ficha.data;
  const [tab, setTab] = useState<string>(focus?.split(':')[0] || 'RESUMO');
  return (
    <Panel
      title={f ? `${f.customer} · ${f.osCode}` : 'Ficha'}
      subtitle={
        f
          ? `${f.orderCode} · ${f.finalCents === null ? 'sem valor aprovado' : `${brl(f.finalCents)} · recebido ${brl(f.receivedCents)}`}`
          : null
      }
      icon="📋"
      onClose={onClose}
      testId="ficha-panel"
      className="h-full"
    >
      <div className="mb-2 flex flex-wrap gap-1">
        {[
          ['RESUMO', 'Resumo'],
          ['CONTRATO', 'Contrato'],
          ['COBRANCA', 'Cobranças'],
          ['NOTA', 'Nota'],
          ['COMPRAS', 'Materiais'],
        ].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k!)}
            data-testid={`ficha-tab-${k}`}
            className={clsx(
              'rounded-full border px-2.5 py-0.5 text-xs font-semibold',
              tab === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {!f ? (
        <p className="text-xs">Carregando…</p>
      ) : tab === 'RESUMO' ? (
        <ol className="space-y-1.5" data-testid="ficha-steps">
          {f.steps.map((s) => (
            <li
              key={s.key}
              className="flex items-start gap-2 rounded-xl border border-line bg-white p-2 text-xs"
              data-testid={`ficha-step-${s.key}`}
            >
              <div className="w-20 shrink-0 font-bold">{s.label}</div>
              <div className="min-w-0 flex-1">
                <Tone tone={toneOf(s.tone)}>{s.state}</Tone>
                {s.detail ? <div className="mt-0.5 text-ink-soft">{s.detail}</div> : null}
                {s.key === 'CONTRATO' && s.ref?.signedFileUrl ? (
                  <a
                    className="text-brand-700 underline"
                    href={String(s.ref.signedFileUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PDF assinado
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : tab === 'CONTRATO' ? (
        <ContractTab orderId={f.orderId} canDocs={canDocs} />
      ) : tab === 'COBRANCA' ? (
        <ChargesTab orderId={f.orderId} canFin={canFin} focus={focus} />
      ) : tab === 'NOTA' ? (
        <FiscalTab orderId={f.orderId} canFin={canFin} />
      ) : (
        <NeedsTab soId={soId} canBuy={canBuy} />
      )}
    </Panel>
  );
}

function ContractTab({ orderId, canDocs }: { orderId: string; canDocs: boolean }) {
  const list = useQuery({
    queryKey: ['office-contracts', orderId],
    queryFn: () => api<ContractRow[]>(`/api/v1/office/orders/${orderId}/contracts`),
  });
  const act = useAct();
  const cur = list.data?.find((c) => ['RASCUNHO', 'ENVIADO', 'ASSINADO'].includes(c.status));
  const [body, setBody] = useState<string | null>(null);
  const [signers, setSigners] = useState<ContractRow['signers'] | null>(null);
  const [review, setReview] = useState(false);
  const draft = cur?.status === 'RASCUNHO' ? cur : null;
  const text = body ?? draft?.body ?? '';
  const sg = signers ?? draft?.signers ?? [];
  const save = async () => {
    if (!draft) return null;
    const r = await act<ContractRow>(
      `/api/v1/office/contracts/${draft.id}`,
      { body: text, signers: sg, version: draft.version },
      'Revisão salva.',
      'PUT',
    );
    if (r) {
      setBody(null);
      setSigners(null);
    }
    return r;
  };
  return (
    <div className="space-y-2 text-xs" data-testid="contract-tab">
      {!cur ? (
        <>
          <p>
            Nenhum contrato vigente. O agente Documentos preenche o modelo da empresa com cliente,
            serviço, tecido, valor, parcelas, prazo, retirada e entrega.
          </p>
          <GBtn
            tone="primary"
            disabled={!canDocs}
            testId="contract-prepare"
            onClick={() =>
              act(
                `/api/v1/office/orders/${orderId}/contract`,
                {},
                'Contrato preparado: revise antes de enviar.',
              )
            }
          >
            Preparar contrato
          </GBtn>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <b>Revisão {cur.revision}</b>
            <Tone tone={cur.status === 'ASSINADO' ? 'ok' : 'atencao'}>
              {{ RASCUNHO: 'Em revisão', ENVIADO: 'Aguardando assinatura', ASSINADO: 'Assinado' }[
                cur.status
              ] ?? cur.status}
            </Tone>
          </div>
          {draft && draft.missing.length ? (
            <div
              className="rounded-lg border border-warn-600/30 bg-warn-50 p-2"
              data-testid="contract-missing"
            >
              Falta preencher: {draft.missing.join(', ')}.
            </div>
          ) : null}
          {draft ? (
            <>
              <textarea
                className="h-56 w-full rounded-lg border border-line-strong p-2 font-mono text-[11px]"
                value={text}
                onChange={(e) => setBody(e.target.value)}
                data-testid="contract-body"
              />
              <div className="font-semibold">Signatários</div>
              {sg.map((s, i) => (
                <div key={i} className="flex gap-1">
                  <input
                    className="w-1/3 rounded border border-line-strong px-1"
                    value={s.name}
                    onChange={(e) =>
                      setSigners(sg.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                    }
                    aria-label="Nome do signatário"
                  />
                  <input
                    className="flex-1 rounded border border-line-strong px-1"
                    value={s.email}
                    placeholder="e-mail"
                    onChange={(e) =>
                      setSigners(sg.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))
                    }
                    aria-label="E-mail do signatário"
                  />
                  <span className="text-ink-muted">{s.role.toLowerCase()}</span>
                </div>
              ))}
              <div className="flex flex-wrap gap-1.5">
                <GBtn disabled={!canDocs || (body === null && signers === null)} onClick={save}>
                  Salvar revisão
                </GBtn>
                <GBtn
                  tone="ghost"
                  disabled={!canDocs}
                  onClick={() =>
                    act(
                      `/api/v1/office/orders/${orderId}/contract`,
                      {},
                      'Contrato refeito pelo modelo (nova revisão).',
                    )
                  }
                >
                  Refazer pelo modelo
                </GBtn>
                <GBtn
                  tone="primary"
                  disabled={!canDocs || (body === null && draft.missing.length > 0)}
                  title={
                    draft.missing.length
                      ? 'Complete o que falta (edite o texto e salve a revisão)'
                      : undefined
                  }
                  testId="contract-review-send"
                  onClick={async () => {
                    if (body !== null || signers !== null) await save();
                    setReview(true);
                  }}
                >
                  Revisar e enviar…
                </GBtn>
              </div>
              {review ? (
                <div
                  className="rounded-xl border-2 border-brand-600/40 bg-brand-50 p-2"
                  data-testid="contract-confirm"
                >
                  <div className="font-bold">Enviar para assinatura?</div>
                  <div>
                    Provedor: Clicksign · signatários:{' '}
                    {sg.map((s) => `${s.name} <${s.email || 'sem e-mail'}>`).join(', ')}.
                  </div>
                  <div className="mt-1 flex gap-1.5">
                    <GBtn
                      tone="primary"
                      testId="contract-send"
                      onClick={async () => {
                        const fresh = (
                          await api<ContractRow[]>(`/api/v1/office/orders/${orderId}/contracts`)
                        ).find((c) => c.id === draft.id);
                        const r = await act(
                          `/api/v1/office/contracts/${draft.id}/send`,
                          { version: fresh?.version ?? draft.version },
                          'Contrato enviado para assinatura.',
                        );
                        if (r) setReview(false);
                      }}
                    >
                      Confirmar envio
                    </GBtn>
                    <GBtn tone="ghost" onClick={() => setReview(false)}>
                      Voltar
                    </GBtn>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <pre className="max-h-56 overflow-y-auto rounded-lg bg-subtle p-2 text-[11px] whitespace-pre-wrap">
                {cur.body}
              </pre>
              {cur.sentAt ? (
                <div>
                  Enviado em {br(cur.sentAt)} (
                  {cur.provider === 'CLICKSIGN_TESTE' ? 'teste local' : 'Clicksign'}).
                </div>
              ) : null}
              {cur.signedFileUrl ? (
                <a
                  className="font-semibold text-brand-700 underline"
                  href={cur.signedFileUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="contract-pdf"
                >
                  Abrir PDF assinado
                </a>
              ) : null}
              {cur.status === 'ENVIADO' && cur.provider === 'CLICKSIGN_TESTE' ? (
                <GBtn
                  tone="bronze"
                  testId="contract-simulate"
                  onClick={() =>
                    act(
                      `/api/v1/office/contracts/${cur.id}/simulate`,
                      { event: 'auto_close' },
                      'Retorno do provedor: assinado.',
                    )
                  }
                >
                  Simular assinatura do cliente (teste)
                </GBtn>
              ) : null}
            </>
          )}
        </>
      )}
      {list.data && list.data.length > 1 ? (
        <Section title="Histórico de revisões">
          {list.data
            .filter((c) => c !== cur)
            .map((c) => (
              <div key={c.id}>
                Rev. {c.revision}: {c.status.toLowerCase()}
              </div>
            ))}
        </Section>
      ) : null}
    </div>
  );
}

function ChargesTab({
  orderId,
  canFin,
  focus,
}: {
  orderId: string;
  canFin: boolean;
  focus: string | null;
}) {
  const recs = useQuery({
    queryKey: ['office-charges', orderId],
    queryFn: () => api<RecRow[]>(`/api/v1/office/orders/${orderId}/charges`),
  });
  const act = useAct();
  const toast = useToast();
  const f = focus?.split(':') ?? [];
  const [mode, setMode] = useState<'ENTRADA_SALDO' | 'CARTAO_TOTAL' | 'A_VISTA'>(
    f[1] === 'CARTAO' ? 'CARTAO_TOTAL' : 'ENTRADA_SALDO',
  );
  const [pct, setPct] = useState(f[1] === 'ENTRADA' ? Number(f[2]) || 50 : 50);
  const [inst, setInst] = useState(f[1] === 'CARTAO' ? Number(f[2]) || 1 : 1);
  const [method, setMethod] = useState<'PIX' | 'BOLETO'>(f[3] === 'BOLETO' ? 'BOLETO' : 'PIX');
  const plan = { mode, entradaPercent: pct, installments: inst, method, saldoTrigger: 'ENTREGA' };
  const prev = useQuery({
    queryKey: ['office-preview', orderId, mode, pct, inst, method],
    queryFn: () =>
      api<Preview>(`/api/v1/office/orders/${orderId}/charges/preview`, {
        method: 'POST',
        body: plan,
      }),
  });
  const [due, setDue] = useState<Record<string, string>>({});
  return (
    <div className="space-y-2 text-xs" data-testid="charges-tab">
      {(recs.data ?? []).map((r) => (
        <div
          key={r.id}
          className="rounded-xl border border-line bg-white p-2"
          data-testid="receivable-row"
        >
          <div className="flex justify-between">
            <b>{r.description}</b>
            <Tone tone={r.status === 'RECEBIDO' ? 'ok' : 'atencao'}>
              {r.status === 'RECEBIDO'
                ? 'Pago'
                : `${brl(r.amountCents - r.receivedCents)} a receber`}
            </Tone>
          </div>
          <div className="text-ink-soft">
            {brl(r.amountCents)} ·{' '}
            {r.dueDate
              ? `vence ${br(r.dueDate)}`
              : r.dueTrigger === 'ENTREGA'
                ? 'vence na entrega'
                : r.dueTrigger.toLowerCase()}
          </div>
          {r.charges.slice(0, 1).map((c) => (
            <div key={c.id} className="mt-1 rounded-lg bg-subtle p-1.5" data-testid="charge-row">
              <div className="flex justify-between">
                <span>
                  {c.billingType} · {c.provider === 'ASAAS_TESTE' ? 'Asaas (teste)' : 'Asaas'}
                </span>
                <b>
                  {{
                    ABERTA: 'Aberta',
                    PAGA: 'Paga',
                    VENCIDA: 'Vencida',
                    CANCELADA: 'Cancelada',
                    ESTORNADA: 'Estornada',
                  }[c.status] ?? c.status}
                  {c.baixada ? ' · baixa pelo provedor' : ''}
                </b>
              </div>
              {c.pixPayload && c.status !== 'PAGA' ? (
                <button
                  className="mt-0.5 block w-full truncate rounded border border-line bg-white px-1 text-left font-mono text-[10px]"
                  title="Copiar Pix"
                  onClick={() => {
                    void navigator.clipboard?.writeText(c.pixPayload!);
                    toast('ok', 'Pix copia e cola copiado.');
                  }}
                >
                  {c.pixPayload}
                </button>
              ) : null}
              {canFin && (c.status === 'ABERTA' || c.status === 'VENCIDA') ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  <input
                    type="date"
                    className="rounded border border-line-strong px-1"
                    value={due[c.id] ?? c.dueDate}
                    onChange={(e) => setDue({ ...due, [c.id]: e.target.value })}
                    aria-label="Novo vencimento"
                  />
                  <GBtn
                    tone="ghost"
                    className="!px-2 !py-0.5 text-xs"
                    disabled={!due[c.id] || due[c.id] === c.dueDate}
                    onClick={() =>
                      act(
                        `/api/v1/office/charges/${c.id}/due`,
                        { dueDate: due[c.id], version: c.version },
                        'Vencimento ajustado.',
                        'PUT',
                      )
                    }
                  >
                    Ajustar
                  </GBtn>
                  <GBtn
                    tone="ghost"
                    className="!px-2 !py-0.5 text-xs"
                    onClick={async () => {
                      const r = await act<{ detail: string }>(
                        `/api/v1/office/charges/${c.id}/whatsapp`,
                        {},
                      );
                      if (r) toast('ok', r.detail);
                    }}
                  >
                    Preparar WhatsApp
                  </GBtn>
                  {c.provider === 'ASAAS_TESTE' ? (
                    <GBtn
                      tone="bronze"
                      className="!px-2 !py-0.5 text-xs"
                      testId="charge-simulate"
                      onClick={() =>
                        act(
                          `/api/v1/office/charges/${c.id}/simulate`,
                          { event: 'PAYMENT_RECEIVED', eventId: `evt_ui_${c.id}` },
                          'Retorno do provedor: pagamento confirmado.',
                        )
                      }
                    >
                      Simular pagamento (teste)
                    </GBtn>
                  ) : null}
                  <GBtn
                    tone="ghost"
                    className="!px-2 !py-0.5 text-xs"
                    onClick={() =>
                      act(`/api/v1/office/charges/${c.id}/cancel`, {}, 'Cobrança cancelada.')
                    }
                  >
                    Cancelar
                  </GBtn>
                </div>
              ) : null}
              {c.provider === 'ASAAS_TESTE' && c.status === 'PAGA' ? (
                <GBtn
                  tone="ghost"
                  className="mt-1 !px-2 !py-0.5 text-xs"
                  testId="charge-resend"
                  onClick={async () => {
                    const r = await act<{ duplicate: boolean; result?: string }>(
                      `/api/v1/office/charges/${c.id}/simulate`,
                      { event: 'PAYMENT_RECEIVED', eventId: `evt_ui_${c.id}` },
                    );
                    if (r)
                      toast(
                        'ok',
                        r.duplicate
                          ? 'Mesma confirmação reenviada: ignorada (sem nova baixa).'
                          : (r.result ?? ''),
                      );
                  }}
                >
                  Reenviar a mesma confirmação (teste)
                </GBtn>
              ) : null}
            </div>
          ))}
          {!r.charges.length && r.status !== 'RECEBIDO' && canFin ? (
            <GBtn
              tone="ghost"
              className="mt-1 !px-2 !py-0.5 text-xs"
              onClick={() =>
                act(
                  `/api/v1/office/receivables/${r.id}/charge`,
                  { billingType: 'PIX', dueDate: new Date().toISOString().slice(0, 10) },
                  'Cobrança emitida.',
                )
              }
            >
              Gerar cobrança Pix agora
            </GBtn>
          ) : null}
        </div>
      ))}
      {prev.data && prev.data.remainingCents > 0 ? (
        <div
          className="rounded-xl border-2 border-brand-600/40 bg-brand-50 p-2"
          data-testid="charge-plan"
        >
          <div className="mb-1 font-bold">
            Plano de cobrança — {brl(prev.data.remainingCents)} a lançar
          </div>
          <div className="mb-1 flex flex-wrap gap-1">
            {(['ENTRADA_SALDO', 'CARTAO_TOTAL', 'A_VISTA'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={clsx(
                  'rounded-full border px-2',
                  mode === m ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white',
                )}
              >
                {
                  { ENTRADA_SALDO: 'Entrada + saldo', CARTAO_TOTAL: 'Cartão', A_VISTA: 'À vista' }[
                    m
                  ]
                }
              </button>
            ))}
          </div>
          {mode === 'ENTRADA_SALDO' ? (
            <label className="mr-2">
              Entrada{' '}
              <input
                type="number"
                min={1}
                max={99}
                className="w-12 rounded border px-1"
                value={pct}
                onChange={(e) => setPct(Number(e.target.value) || 50)}
              />
              %
            </label>
          ) : null}
          {mode === 'CARTAO_TOTAL' ? (
            <label>
              Parcelas{' '}
              <input
                type="number"
                min={1}
                max={12}
                className="w-12 rounded border px-1"
                value={inst}
                onChange={(e) => setInst(Number(e.target.value) || 1)}
              />
            </label>
          ) : (
            <select
              className="rounded border px-1"
              value={method}
              onChange={(e) => setMethod(e.target.value as 'PIX' | 'BOLETO')}
            >
              <option value="PIX">Pix</option>
              <option value="BOLETO">Boleto</option>
            </select>
          )}
          <ul className="my-1 list-disc pl-4">
            {prev.data.lines.map((l, i) => (
              <li key={i}>
                {l.description}: <b>{brl(l.amountCents)}</b>{' '}
                {l.dueDate
                  ? `vence ${br(l.dueDate)}`
                  : l.dueTrigger === 'ENTREGA'
                    ? '(na entrega)'
                    : ''}
                {l.emitNow ? ' — emite agora' : ' — emite depois'}
              </li>
            ))}
          </ul>
          <div className="text-ink-soft">
            {prev.data.provider
              ? `Provedor: ${prev.data.provider.label}`
              : 'Cobranças: conecte o Asaas (ou a conta de teste) na Central.'}
          </div>
          <GBtn
            tone="primary"
            className="mt-1"
            disabled={!canFin}
            testId="charge-approve"
            onClick={() =>
              act(
                `/api/v1/office/orders/${orderId}/charges`,
                plan,
                'Contas a receber lançadas e cobrança emitida.',
              )
            }
          >
            Aprovar e emitir
          </GBtn>
        </div>
      ) : null}
    </div>
  );
}

function FiscalTab({ orderId, canFin }: { orderId: string; canFin: boolean }) {
  const docs = useQuery({
    queryKey: ['office-fiscal', orderId],
    queryFn: () => api<FiscalRow[]>(`/api/v1/office/orders/${orderId}/fiscal`),
  });
  const act = useAct();
  const d = docs.data?.[0];
  const [review, setReview] = useState(false);
  return (
    <div className="space-y-2 text-xs" data-testid="fiscal-tab">
      {!d ? (
        <GBtn
          tone="primary"
          disabled={!canFin}
          testId="fiscal-prepare"
          onClick={() =>
            act(`/api/v1/office/orders/${orderId}/fiscal`, {}, 'Nota preparada: revise.')
          }
        >
          Preparar NFS-e
        </GBtn>
      ) : (
        <div className="rounded-xl border border-line bg-white p-2">
          <div className="flex justify-between">
            <b>{d.profile.name}</b>
            <Tone tone={d.status === 'AUTORIZADA' ? 'ok' : 'atencao'}>
              {d.status === 'AUTORIZADA'
                ? `Autorizada nº ${d.number}`
                : d.status === 'RASCUNHO'
                  ? 'Em revisão'
                  : d.status}
            </Tone>
          </div>
          <div className="mt-1">{d.description}</div>
          <div className="font-semibold">{brl(d.amountCents)}</div>
          {d.missing.length ? (
            <div
              className="mt-1 rounded-lg border border-warn-600/30 bg-warn-50 p-2"
              data-testid="fiscal-missing"
            >
              Para emitir falta: {d.missing.join('; ')}.
            </div>
          ) : null}
          {d.files.map((f) => (
            <a
              key={f.url}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className="mr-2 text-brand-700 underline"
            >
              {f.name}
            </a>
          ))}
          {d.status === 'RASCUNHO' && canFin ? (
            review ? (
              <div className="mt-1 rounded-lg border-2 border-brand-600/40 bg-brand-50 p-2">
                Autorizar a emissão de {brl(d.amountCents)} ({d.profile.name})?
                <div className="mt-1 flex gap-1.5">
                  <GBtn
                    tone="primary"
                    testId="fiscal-authorize"
                    onClick={async () => {
                      await act(
                        `/api/v1/office/fiscal/${d.id}/authorize`,
                        { version: d.version },
                        'Nota autorizada.',
                      );
                      setReview(false);
                    }}
                  >
                    Autorizar
                  </GBtn>
                  <GBtn tone="ghost" onClick={() => setReview(false)}>
                    Voltar
                  </GBtn>
                </div>
              </div>
            ) : (
              <GBtn
                className="mt-1"
                disabled={d.missing.length > 0}
                onClick={() => setReview(true)}
              >
                Revisar e autorizar…
              </GBtn>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}

function NeedsTab({ soId, canBuy }: { soId: string; canBuy: boolean }) {
  const q = useQuery({
    queryKey: ['office-needs', soId],
    queryFn: () =>
      api<{
        state: string;
        lines: {
          description?: string;
          material?: string;
          stage?: string;
          need?: number;
          missing?: number;
        }[];
        quotes: {
          id: string;
          supplier: string;
          description: string;
          totalCents: number;
          leadDays: number | null;
          chosen: boolean;
        }[];
        purchaseHref: string | null;
      }>(`/api/v1/office/service-orders/${soId}/needs`),
  });
  const act = useAct();
  if (!q.data) return <p className="text-xs">Carregando…</p>;
  return (
    <div className="space-y-2 text-xs">
      <div>
        Situação: <b>{q.data.state.replace(/_/g, ' ').toLowerCase()}</b>
      </div>
      {q.data.quotes.length ? (
        <Section title="Cotações">
          {q.data.quotes.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-1 rounded-lg border border-line bg-white p-1.5"
            >
              <span>
                {c.supplier}: {c.description} — <b>{brl(c.totalCents)}</b>
                {c.leadDays !== null ? ` · ${c.leadDays} dias` : ''}
              </span>
              {c.chosen ? (
                <Tone tone="ok">escolhida</Tone>
              ) : (
                <GBtn
                  tone="ghost"
                  className="!px-2 !py-0.5 text-xs"
                  disabled={!canBuy}
                  onClick={async () => {
                    const r = await act<{ href: string }>(
                      `/api/v1/office/quotes/${c.id}/choose`,
                      {},
                    );
                    if (r) window.open(r.href, '_blank', 'noopener');
                  }}
                >
                  Escolher e abrir pedido
                </GBtn>
              )}
            </div>
          ))}
        </Section>
      ) : null}
      {q.data.purchaseHref ? (
        <a
          className="font-semibold text-brand-700 underline"
          href={q.data.purchaseHref}
          target="_blank"
          rel="noreferrer"
        >
          Abrir pedido de compra oficial com estas necessidades
        </a>
      ) : (
        <p>Sem necessidades de material registradas.</p>
      )}
      <p className="text-ink-muted">
        A previsão de chegada, a conta a pagar e o recebimento seguem o fluxo oficial de compras.
      </p>
    </div>
  );
}

// ─────────────────────────────── Painel financeiro ───────────────────────────────

interface Forecast {
  from: string;
  to: string;
  inCents: number;
  outCents: number;
  netCents: number;
  receivables: { id: string; label: string; amountCents: number; dueDate: string }[];
  overdue: { id: string; label: string; amountCents: number; dueDate: string }[];
  payables: { id: string; label: string; amountCents: number; dueDate: string; overdue: boolean }[];
  cards: { netCents: number; expectedDate: string }[];
}
interface PayableRow {
  id: string;
  beneficiary: string;
  description: string;
  amountCents: number;
  dueDate: string;
  paymentOrder: { id: string; status: string; version: number } | null;
}
interface TxRow {
  id: string;
  account: string;
  date: string;
  amountCents: number;
  description: string;
  suggestions: { kind: string; refType: string; refId: string; label: string }[];
}
interface Closing {
  month: string;
  groups: {
    kind: string;
    label: string;
    docs: { id: string; title: string; url: string | null }[];
  }[];
  totals: { receivedCents: number; paidCents: number };
  pending: { kind: string; label: string }[];
}

export function FinancePanel({
  filter,
  onClose,
  onOpenFicha,
}: {
  filter: string | null;
  onClose: () => void;
  onOpenFicha: (soId: string) => void;
}) {
  const initial = filter?.split(':')[0] ?? 'HOJE';
  const [tab, setTab] = useState(
    ['HOJE', 'PAGAR', 'BANCO', 'FECHAMENTO', 'FISCAL', 'ENTREGAS'].includes(initial)
      ? initial
      : 'HOJE',
  );
  return (
    <Panel
      title="Financeiro do escritório"
      subtitle="Agente Financeiro · tudo com sua confirmação"
      icon="💼"
      onClose={onClose}
      testId="finance-panel"
      className="h-full"
    >
      <div className="mb-2 flex flex-wrap gap-1">
        {[
          ['HOJE', 'Previsão'],
          ['PAGAR', 'Pagar'],
          ['BANCO', 'Banco'],
          ['FECHAMENTO', 'Fechamento'],
          ['FISCAL', 'Fiscal'],
          ['ENTREGAS', 'Entregas'],
        ].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k!)}
            data-testid={`fin-tab-${k}`}
            className={clsx(
              'rounded-full border px-2.5 py-0.5 text-xs font-semibold',
              tab === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'HOJE' ? (
        <ForecastTab />
      ) : tab === 'PAGAR' ? (
        <PayTab highlight={filter?.split(':')[1] ?? null} />
      ) : tab === 'BANCO' ? (
        <BankTab />
      ) : tab === 'FECHAMENTO' ? (
        <ClosingTab />
      ) : tab === 'FISCAL' ? (
        <ProfilesTab />
      ) : (
        <DeliveriesTab date={filter?.split(':')[1] ?? null} onOpenFicha={onOpenFicha} />
      )}
    </Panel>
  );
}

function ForecastTab() {
  const [days, setDays] = useState(7);
  const q = useQuery({
    queryKey: ['office-forecast', days],
    queryFn: () => api<Forecast>(`/api/v1/office/forecast?days=${days}`),
  });
  const card = useQuery({
    queryKey: ['office-card'],
    queryFn: () =>
      api<{
        sold: { gross: number; fee: number; net: number };
        received: { net: number };
        toFall: { net: number };
      }>('/api/v1/office/card/summary'),
  });
  const d = q.data;
  return (
    <div className="space-y-2 text-xs" data-testid="forecast-tab">
      <div className="flex gap-1">
        {[7, 30].map((n) => (
          <button
            key={n}
            onClick={() => setDays(n)}
            className={clsx(
              'rounded-full border px-2',
              days === n ? 'border-brand-600 bg-brand-600 text-white' : 'bg-white',
            )}
          >
            {n} dias
          </button>
        ))}
      </div>
      {d ? (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <div className="rounded-lg bg-ok-50 p-2">
              <div className="text-ink-muted">Entra</div>
              <b>{brl(d.inCents)}</b>
            </div>
            <div className="rounded-lg bg-danger-50 p-2">
              <div className="text-ink-muted">Sai</div>
              <b>{brl(d.outCents)}</b>
            </div>
            <div className="rounded-lg bg-subtle p-2">
              <div className="text-ink-muted">Saldo previsto</div>
              <b>{brl(d.netCents)}</b>
            </div>
          </div>
          {d.overdue.length ? (
            <Section title="Recebimentos vencidos">
              {d.overdue.map((r) => (
                <div key={r.id}>
                  {r.label} — <b>{brl(r.amountCents)}</b> ({br(r.dueDate)})
                </div>
              ))}
            </Section>
          ) : null}
          <Section title="A receber">
            {d.receivables.length ? (
              d.receivables.map((r) => (
                <div key={r.id}>
                  {br(r.dueDate)} · {r.label} — <b>{brl(r.amountCents)}</b>
                </div>
              ))
            ) : (
              <div className="text-ink-muted">Nada no período.</div>
            )}
          </Section>
          <Section title="A pagar">
            {d.payables.length ? (
              d.payables.map((p) => (
                <div key={p.id} className={p.overdue ? 'text-danger-700' : ''}>
                  {br(p.dueDate)} · {p.label} — <b>{brl(p.amountCents)}</b>
                </div>
              ))
            ) : (
              <div className="text-ink-muted">Nada no período.</div>
            )}
          </Section>
        </>
      ) : null}
      {card.data ? (
        <Section title="Maquininha (semana)">
          <div>
            Vendido {brl(card.data.sold.gross)} · taxas {brl(card.data.sold.fee)} · líquido{' '}
            {brl(card.data.sold.net)}
          </div>
          <div>
            Já caiu {brl(card.data.received.net)} · ainda cai {brl(card.data.toFall.net)}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function PayTab({ highlight }: { highlight: string | null }) {
  const q = useQuery({
    queryKey: ['office-payables'],
    queryFn: () => api<PayableRow[]>('/api/v1/office/payables'),
  });
  const accounts = useQuery({
    queryKey: ['office-accounts'],
    queryFn: () =>
      api<{ id: string; label: string; bank: string; masked: string | null }[]>(
        '/api/v1/office/bank/accounts',
      ),
  });
  const act = useAct();
  const [prep, setPrep] = useState<string | null>(highlight);
  const [acc, setAcc] = useState('');
  const [method, setMethod] = useState('PIX');
  return (
    <div className="space-y-1.5 text-xs" data-testid="pay-tab">
      {(q.data ?? []).map((p) => (
        <div
          key={p.id}
          className={clsx(
            'rounded-xl border bg-white p-2',
            highlight === p.id ? 'border-brand-600' : 'border-line',
          )}
        >
          <div className="flex justify-between">
            <b>{p.beneficiary}</b>
            <b>{brl(p.amountCents)}</b>
          </div>
          <div className="text-ink-soft">
            {p.description} · vence {br(p.dueDate)}
          </div>
          {p.paymentOrder ? (
            p.paymentOrder.status === 'PREPARADO' ? (
              <GBtn
                tone="primary"
                className="mt-1 !px-2 !py-0.5 text-xs"
                testId="pay-confirm"
                onClick={() =>
                  act(
                    `/api/v1/office/payment-orders/${p.paymentOrder!.id}/confirm`,
                    { version: p.paymentOrder!.version },
                    'Confirmado. Autorize no app do banco; a baixa vem pelo extrato.',
                  )
                }
              >
                Confirmar pagamento
              </GBtn>
            ) : (
              <Tone tone="atencao">Aguardando autorização no app do banco</Tone>
            )
          ) : prep === p.id ? (
            <div className="mt-1 rounded-lg border-2 border-brand-600/40 bg-brand-50 p-2">
              <div>
                Favorecido <b>{p.beneficiary}</b> · valor <b>{brl(p.amountCents)}</b> · vencimento{' '}
                <b>{br(p.dueDate)}</b>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <select
                  className="rounded border px-1"
                  value={acc}
                  onChange={(e) => setAcc(e.target.value)}
                  aria-label="Conta de origem"
                >
                  <option value="">Conta de origem…</option>
                  {accounts.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ({a.bank} {a.masked ?? ''})
                    </option>
                  ))}
                </select>
                <select
                  className="rounded border px-1"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  <option value="PIX">Pix</option>
                  <option value="BOLETO">Boleto</option>
                  <option value="TRANSFERENCIA">Transferência</option>
                </select>
                <GBtn
                  tone="primary"
                  className="!px-2 !py-0.5 text-xs"
                  disabled={!acc}
                  testId="pay-prepare"
                  onClick={async () => {
                    await act(
                      `/api/v1/office/payables/${p.id}/payment-order`,
                      { accountId: acc, method },
                      'Pagamento preparado.',
                    );
                    setPrep(null);
                  }}
                >
                  Preparar
                </GBtn>
              </div>
              {!accounts.data?.length ? (
                <div className="mt-1 text-warn-600">Cadastre a conta PJ na aba Banco.</div>
              ) : null}
            </div>
          ) : (
            <GBtn tone="ghost" className="mt-1 !px-2 !py-0.5 text-xs" onClick={() => setPrep(p.id)}>
              Preparar pagamento…
            </GBtn>
          )}
        </div>
      ))}
      {q.data && !q.data.length ? <p className="text-ink-muted">Nenhuma conta em aberto.</p> : null}
      <p className="text-ink-muted">
        Pagamento só é marcado como pago quando o extrato (conciliação) ou o provedor confirmar.
      </p>
    </div>
  );
}

function BankTab() {
  const accounts = useQuery({
    queryKey: ['office-accounts'],
    queryFn: () =>
      api<{ id: string; label: string; bank: string }[]>('/api/v1/office/bank/accounts'),
  });
  const txs = useQuery({
    queryKey: ['office-txs'],
    queryFn: () => api<TxRow[]>('/api/v1/office/bank/transactions'),
  });
  const act = useAct();
  const toast = useToast();
  const [form, setForm] = useState({ label: 'Conta PJ', bank: '' });
  const [content, setContent] = useState('');
  const acc = accounts.data?.[0];
  return (
    <div className="space-y-2 text-xs" data-testid="bank-tab">
      {!acc ? (
        <div className="flex gap-1">
          <input
            className="w-24 rounded border px-1"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            aria-label="Nome da conta"
          />
          <input
            className="flex-1 rounded border px-1"
            placeholder="Banco"
            value={form.bank}
            onChange={(e) => setForm({ ...form, bank: e.target.value })}
            aria-label="Banco"
          />
          <GBtn
            className="!px-2 !py-0.5 text-xs"
            disabled={form.bank.length < 2}
            onClick={() => act('/api/v1/office/bank/accounts', form, 'Conta cadastrada.')}
          >
            Cadastrar
          </GBtn>
        </div>
      ) : (
        <>
          <div>
            Conta: <b>{acc.label}</b> ({acc.bank})
          </div>
          <label className="block">
            Importar extrato (OFX ou CSV data;descrição;valor)
            <input
              type="file"
              accept=".ofx,.csv,.txt"
              className="block"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setContent(await f.text());
              }}
            />
          </label>
          <textarea
            className="h-16 w-full rounded border p-1 font-mono text-[10px]"
            placeholder="…ou cole o conteúdo"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            data-testid="bank-content"
          />
          <GBtn
            className="!px-2 !py-0.5 text-xs"
            disabled={content.length < 10}
            testId="bank-import"
            onClick={async () => {
              const r = await act<{ imported: number; duplicates: number }>(
                `/api/v1/office/bank/accounts/${acc.id}/import`,
                { format: /<OFX>|<STMTTRN>/i.test(content) ? 'OFX' : 'CSV', content },
              );
              if (r) {
                toast(
                  'ok',
                  `${r.imported} lançamento(s) novo(s), ${r.duplicates} já importado(s).`,
                );
                setContent('');
              }
            }}
          >
            Importar
          </GBtn>
        </>
      )}
      <Section title="Conciliar">
        {(txs.data ?? []).map((t) => (
          <div
            key={t.id}
            className="mb-1 rounded-lg border border-line bg-white p-1.5"
            data-testid="bank-tx"
          >
            <div className="flex justify-between">
              <span>
                {br(t.date)} · {t.description}
              </span>
              <b className={t.amountCents < 0 ? 'text-danger-700' : 'text-ok-600'}>
                {brl(t.amountCents)}
              </b>
            </div>
            {t.suggestions.map((s) => (
              <button
                key={s.refId}
                className="mt-0.5 block w-full rounded border border-brand-600/30 bg-brand-50 px-1 text-left"
                onClick={() =>
                  act(
                    `/api/v1/office/bank/transactions/${t.id}/reconcile`,
                    { refType: s.refType, refId: s.refId },
                    'Conciliado.',
                  )
                }
              >
                ✓ {s.label}
              </button>
            ))}
            <button
              className="mt-0.5 text-ink-muted underline"
              onClick={() =>
                act(
                  `/api/v1/office/bank/transactions/${t.id}/reconcile`,
                  { refType: 'ignorar' },
                  'Marcado como sem vínculo.',
                )
              }
            >
              Sem vínculo (tarifa, transferência interna…)
            </button>
          </div>
        ))}
        {txs.data && !txs.data.length ? <p className="text-ink-muted">Nada pendente.</p> : null}
      </Section>
    </div>
  );
}

function ClosingTab() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const q = useQuery({
    queryKey: ['office-closing', month],
    queryFn: () => api<Closing>(`/api/v1/office/accounting/${month}`),
  });
  return (
    <div className="space-y-2 text-xs" data-testid="closing-tab">
      <input
        type="month"
        className="rounded border px-1"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        aria-label="Mês"
      />
      {q.data ? (
        <>
          <div>
            Recebido {brl(q.data.totals.receivedCents)} · pago {brl(q.data.totals.paidCents)}
          </div>
          {q.data.pending.length ? (
            <div className="rounded-lg border border-warn-600/30 bg-warn-50 p-2">
              <b>Pendências</b>
              {q.data.pending.map((p, i) => (
                <div key={i}>• {p.label}</div>
              ))}
            </div>
          ) : (
            <Tone tone="ok">Sem pendências</Tone>
          )}
          {q.data.groups.map((g) =>
            g.docs.length ? (
              <Section key={g.kind} title={`${g.label} (${g.docs.length})`}>
                {g.docs.map((d) => (
                  <div key={d.id}>
                    {d.url ? (
                      <a
                        className="text-brand-700 underline"
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.title}
                      </a>
                    ) : (
                      d.title
                    )}
                  </div>
                ))}
              </Section>
            ) : null,
          )}
          <a
            className="inline-block rounded-xl bg-brand-600 px-3 py-1.5 font-semibold text-white"
            href={`/api/v1/office/accounting/${month}/package`}
            data-testid="closing-download"
          >
            Baixar pacote para a contabilidade (.zip)
          </a>
          <p className="text-ink-muted">
            Envio automático por e-mail ao escritório contábil: conecte o e-mail na Central
            (planejado).
          </p>
        </>
      ) : null}
    </div>
  );
}

function ProfilesTab() {
  const q = useQuery({
    queryKey: ['office-profiles'],
    queryFn: () =>
      api<
        {
          id: string;
          name: string;
          documentKind: string;
          serviceCode: string | null;
          municipalTaxCode: string | null;
          cnae: string | null;
          issRatePercent: number | null;
          ncm: string | null;
          cfop: string | null;
          descriptionTemplate: string;
          validatedByAccountant: boolean;
          version: number;
          missing: string[];
          hint: string | null;
        }[]
      >('/api/v1/office/fiscal/profiles'),
  });
  const act = useAct();
  const [edit, setEdit] = useState<Record<string, Record<string, unknown>>>({});
  return (
    <div className="space-y-2 text-xs" data-testid="profiles-tab">
      {(q.data ?? []).map((p) => {
        const e = { ...p, ...(edit[p.id] ?? {}) } as typeof p;
        const set = (k: string, v: unknown) =>
          setEdit({ ...edit, [p.id]: { ...(edit[p.id] ?? {}), [k]: v } });
        return (
          <div key={p.id} className="rounded-xl border border-line bg-white p-2">
            <div className="flex justify-between">
              <b>{p.name}</b>
              <Tone tone={p.missing.length ? 'atencao' : 'ok'}>
                {p.missing.length ? 'Incompleto' : 'Pronto para emitir'}
              </Tone>
            </div>
            {p.hint ? <p className="my-1 text-ink-soft">{p.hint}</p> : null}
            <div className="grid grid-cols-2 gap-1">
              <label>
                Documento{' '}
                <select
                  className="w-full rounded border"
                  value={e.documentKind}
                  onChange={(x) => set('documentKind', x.target.value)}
                >
                  <option value="NFSE">NFS-e</option>
                  <option value="NFE">NF-e</option>
                </select>
              </label>
              {e.documentKind === 'NFSE' ? (
                <>
                  <label>
                    Cód. tributação nacional{' '}
                    <input
                      className="w-full rounded border px-1"
                      value={e.serviceCode ?? ''}
                      onChange={(x) => set('serviceCode', x.target.value || null)}
                    />
                  </label>
                  <label>
                    Alíquota ISS %{' '}
                    <input
                      type="number"
                      step="0.01"
                      className="w-full rounded border px-1"
                      value={e.issRatePercent ?? ''}
                      onChange={(x) =>
                        set('issRatePercent', x.target.value === '' ? null : Number(x.target.value))
                      }
                    />
                  </label>
                  <label>
                    CNAE{' '}
                    <input
                      className="w-full rounded border px-1"
                      value={e.cnae ?? ''}
                      onChange={(x) => set('cnae', x.target.value || null)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    NCM{' '}
                    <input
                      className="w-full rounded border px-1"
                      value={e.ncm ?? ''}
                      onChange={(x) => set('ncm', x.target.value || null)}
                    />
                  </label>
                  <label>
                    CFOP{' '}
                    <input
                      className="w-full rounded border px-1"
                      value={e.cfop ?? ''}
                      onChange={(x) => set('cfop', x.target.value || null)}
                    />
                  </label>
                </>
              )}
            </div>
            <label className="mt-1 flex items-center gap-1">
              <input
                type="checkbox"
                checked={e.validatedByAccountant}
                onChange={(x) => set('validatedByAccountant', x.target.checked)}
              />{' '}
              Validado pela contabilidade
            </label>
            <GBtn
              className="mt-1 !px-2 !py-0.5 text-xs"
              disabled={!edit[p.id]}
              onClick={async () => {
                const r = await act(
                  `/api/v1/office/fiscal/profiles/${p.id}`,
                  {
                    documentKind: e.documentKind,
                    serviceCode: e.serviceCode,
                    municipalTaxCode: e.municipalTaxCode,
                    cnae: e.cnae,
                    issRatePercent: e.issRatePercent,
                    ncm: e.ncm,
                    cfop: e.cfop,
                    descriptionTemplate: e.descriptionTemplate,
                    validatedByAccountant: e.validatedByAccountant,
                    version: p.version,
                  },
                  'Perfil salvo.',
                  'PUT',
                );
                if (r) setEdit({ ...edit, [p.id]: undefined as never });
              }}
            >
              Salvar perfil
            </GBtn>
          </div>
        );
      })}
    </div>
  );
}

function DeliveriesTab({
  date: initial,
  onOpenFicha,
}: {
  date: string | null;
  onOpenFicha: (soId: string) => void;
}) {
  const [date, setDate] = useState(
    () => initial ?? new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
  );
  const q = useQuery({
    queryKey: ['office-deliveries', date],
    queryFn: () =>
      api<{
        deliveries: {
          id: string;
          stop: number;
          status: string;
          customer: string;
          address: string;
          window: string | null;
          pieces: string[];
          balanceCents: number;
          photos: number;
          invoice: string | null;
          serviceOrderIds: string[];
        }[];
      }>(`/api/v1/office/deliveries?date=${date}`),
  });
  return (
    <div className="space-y-1.5 text-xs" data-testid="deliveries-tab">
      <input
        type="date"
        className="rounded border px-1"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        aria-label="Dia"
      />
      {(q.data?.deliveries ?? []).map((d) => (
        <button
          key={d.id}
          className="block w-full rounded-xl border border-line bg-white p-2 text-left"
          onClick={() => d.serviceOrderIds[0] && onOpenFicha(d.serviceOrderIds[0])}
        >
          <div className="flex justify-between">
            <b>
              {d.stop}. {d.customer}
            </b>
            {d.balanceCents > 0 ? (
              <Tone tone="atencao">cobrar {brl(d.balanceCents)}</Tone>
            ) : (
              <Tone tone="ok">quitado</Tone>
            )}
          </div>
          <div className="text-ink-soft">
            {d.address}
            {d.window ? ` · ${d.window}` : ''}
          </div>
          <div>{d.pieces.join(' · ')}</div>
          <div className="text-ink-muted">
            {d.status.toLowerCase()} · {d.photos} foto(s) · nota {d.invoice ?? 'pendente'}
          </div>
        </button>
      ))}
      {q.data && !q.data.deliveries.length ? (
        <p className="text-ink-muted">Nenhuma entrega neste dia.</p>
      ) : null}
      <p className="text-ink-muted">
        Agendar, registrar fotos/comprovante e concluir a entrega continuam no fluxo oficial de
        entregas.
      </p>
    </div>
  );
}
