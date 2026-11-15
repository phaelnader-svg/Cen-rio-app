'use client';
/**
 * Ficha da OS ao clicar no móvel. Tudo vem das rotas oficiais (OS, prontidão, fotos, tarefas) e
 * as ações usam os mesmos fluxos do painel: planejar serviço (titular + data), publicar a semana
 * (a tarefa vai para a fila do tablet), trocar o responsável de uma etapa com motivo e versão.
 * O início continua sendo confirmado pelo funcionário no tablet.
 */
import {
  ACTIVITY_LABEL_GAME,
  FULFILLMENT_STAGE_LABEL,
  type FulfillmentStage,
  type GamePieceDto,
  type GameSnapshotDto,
  type ProductionPlanDto,
  type ProductionTaskDetailDto,
  type PurchaseShortageDto,
  type ReadinessLineDto,
  pieceWorkflow,
} from '@cenario/shared';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MapPin, ShoppingCart } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { type GamePerson, usePhotos, useReadiness, useServiceOrder } from './game-api';
import {
  GBtn,
  KV,
  Panel,
  Section,
  TASK_STATUS_LABEL,
  Tone,
  UNIT_LABEL,
  fmtDate,
  fmtDateTime,
  fmtQty,
} from './ui';

const MODEL_ICON: Record<string, string> = {
  SOFA: '🛋️',
  SOFA_RETRATIL: '🛋️',
  SOFA_CANTO: '🛋️',
  POLTRONA: '💺',
  CADEIRA: '🪑',
  CABECEIRA: '🛏️',
  PUFE: '🟫',
  BANCO: '🪑',
  COLCHAO: '🛏️',
  OUTRO: '📦',
};
const SERVICE_LABEL: Record<string, string> = {
  REFORMA_COMPLETA: 'Reforma completa',
  TROCA_DE_TECIDO: 'Troca de tecido',
  TROCA_DE_ESPUMA: 'Troca de espuma',
  REPARO: 'Reparo',
  FABRICACAO: 'Fabricação',
  INSTALACAO: 'Instalação',
  OUTRO: 'Outro',
};
const PRIORITY_LABEL: Record<string, string> = {
  BAIXA: 'Baixa',
  NORMAL: 'Normal',
  ALTA: 'Alta',
  URGENTE: 'Urgente',
};

function lineTone(l: ReadinessLineDto): {
  tone: 'FALTA' | 'DISPONIVEL' | 'A_CONFERIR';
  text: string;
} {
  if (l.forecast) return { tone: 'A_CONFERIR', text: 'Previsão (a conferir)' };
  if (l.covered >= l.need - 1e-9) return { tone: 'DISPONIVEL', text: 'Disponível para a OS' };
  if (l.awaiting > 0 && l.covered + l.awaiting >= l.need - 1e-9)
    return { tone: 'FALTA', text: 'Comprado, aguardando chegada' };
  return {
    tone: 'FALTA',
    text: `Falta ${fmtQty(Math.max(0, l.need - l.covered - l.awaiting))} ${UNIT_LABEL[l.unit] ?? l.unit}`,
  };
}

export function PiecePanel({
  piece,
  snapshot,
  people,
  onClose,
  onLocateMaterial,
  onFocusEmployee,
  onOpenFicha,
}: {
  piece: GamePieceDto;
  snapshot: GameSnapshotDto;
  people: GamePerson[];
  onClose: () => void;
  onLocateMaterial: (description: string) => void;
  onFocusEmployee: (userId: string) => void;
  /** Ficha comercial (contrato, entrada, saldo, nota) — só com permissão de pedidos/financeiro. */
  onOpenFicha?: () => void;
}) {
  const so = useServiceOrder(piece.serviceOrderId);
  const readiness = useReadiness(piece.serviceOrderId);
  const photosOs = usePhotos('SERVICE_ORDER', piece.serviceOrderId);
  const photosItem = usePhotos('SERVICE_ORDER_ITEM', piece.id);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const atShipping = [
    'BLOQUEIO_EXPEDICAO',
    'PRONTA_ENTREGA',
    'ENTREGA_AGENDADA',
    'EM_TRANSPORTE',
  ].includes(piece.stage);
  const balance = useQuery({
    queryKey: ['office-ficha', piece.serviceOrderId],
    queryFn: () =>
      api<{ balanceCents: number | null; finalCents: number | null }>(
        `/api/v1/office/service-orders/${piece.serviceOrderId}/ficha`,
      ),
    enabled: Boolean(onOpenFicha) && atShipping,
  });
  const siblings = snapshot.pieces.filter((p) => p.serviceOrderId === piece.serviceOrderId);
  const upholsterers = people.filter((p) => p.roles.some((r) => /tapeceir/i.test(r)));
  const workers = people.filter((p) =>
    p.roles.some((r) => /tapeceir|ajudante|qualidade|cabeceira/i.test(r)),
  );
  const [plan, setPlan] = useState(() => ({
    startDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
      new Date(),
    ),
    priority: piece.priority,
    owners: Object.fromEntries(
      siblings.map((s) => [s.id, s.upholstererUserId ?? upholsterers[0]?.userId ?? '']),
    ) as Record<string, string>,
  }));

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['game-snapshot'] }),
      qc.invalidateQueries({ queryKey: ['service-order', piece.serviceOrderId] }),
      qc.invalidateQueries({ queryKey: ['game-readiness', piece.serviceOrderId] }),
    ]);
  };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast('ok', label);
      await refresh();
    } catch (e) {
      toast(
        'danger',
        e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente de novo.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const planService = () =>
    run('Serviço planejado (rascunho). Publique a semana para ir à fila dos tablets.', () =>
      api('/api/v1/production/plan-services', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: {
          entries: [
            {
              serviceOrderId: piece.serviceOrderId,
              startDate: plan.startDate,
              priority: plan.priority,
              pieces: siblings
                .filter((s) => plan.owners[s.id])
                .map((s) => ({ serviceOrderItemId: s.id, upholstererUserId: plan.owners[s.id]! })),
            },
          ],
        },
      }),
    );

  const draftPlanId = piece.tasks.find((t) => t.status === 'RASCUNHO')?.planId ?? null;
  const publish = () =>
    run('Semana publicada: as etapas estão na fila dos tablets.', async () => {
      const p = await api<ProductionPlanDto & { version: number }>(
        `/api/v1/production-plans/${draftPlanId}`,
      );
      await api(`/api/v1/production-plans/${draftPlanId}/publish`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { version: p.version, notes: 'Publicado pelo jogo de gestão' },
      });
    });

  const reassign = (taskId: string, version: number, userId: string, published: boolean) =>
    run('Responsável atualizado.', () =>
      api(`/api/v1/production-tasks/${taskId}`, {
        method: 'PUT',
        body: {
          assigneeUserId: userId || null,
          version,
          ...(published ? { reason: 'Atribuído pelo jogo de gestão' } : {}),
        },
      }),
    );

  const allPhotos = [...(photosOs.data ?? []), ...(photosItem.data ?? [])].filter((p) =>
    p.mimeType.startsWith('image/'),
  );
  const lines = (readiness.data?.lines ?? []).filter(
    (l) => !l.itemCode || l.itemCode === piece.itemCode || siblings.length > 1,
  );
  const missing = lines.filter((l) => l.covered < l.need - 1e-9 && !l.forecast);
  const wf = pieceWorkflow(piece);
  const [tab, setTab] = useState<'MATERIAIS' | 'ATRIBUICAO' | 'SERVICO' | 'HISTORICO'>('MATERIAIS');
  // Mesma fonte da central de compras: estoque livre e compra de estoque sem destino.
  const shortages = useQuery({
    queryKey: ['needs', 'shortages'],
    queryFn: () => api<PurchaseShortageDto[]>('/api/v1/purchasing/shortages'),
    retry: false,
    staleTime: 10_000,
  });
  const explain = (l: ReadinessLineDto) => {
    const g = shortages.data?.find((x) => x.rows.some((r) => r.requirementId === l.requirementId));
    const stockLine = l.sourcing === 'ESTOQUE';
    const free = stockLine ? Math.max(0, g?.freeStock ?? 0) : 0;
    const pending = stockLine ? Math.max(0, g?.freePending ?? 0) : 0;
    const toReserve = stockLine ? Math.min(l.shortfall, free) : 0;
    const toBuy = Math.max(0, Math.round((l.shortfall - free - pending) * 1000) / 1000);
    return {
      free,
      pending,
      toReserve,
      toBuy,
      stockItemId: g?.stockItem?.id ?? null,
      known: Boolean(g) || !stockLine,
    };
  };
  const reserve = (l: ReadinessLineDto, qty: number, stockItemId: string) =>
    run(
      `Reservado ${fmtQty(qty)} ${UNIT_LABEL[l.unit] ?? l.unit} de ${l.description} para ${piece.osCode}.`,
      async () => {
        await api('/api/v1/stock-reservations', {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: {
            stockItemId,
            serviceOrderId: piece.serviceOrderId,
            materialRequirementId: l.requirementId,
            quantity: qty,
          },
        });
        await qc.invalidateQueries({ queryKey: ['needs'] });
      },
    );
  const fabricLine = lines.find((l) => l.kind === 'TECIDO');
  const fabricText = piece.fabric
    ? piece.fabric
    : fabricLine
      ? `${fabricLine.description}${fabricLine.color ? ` · ${fabricLine.color}` : ''} — da lista de materiais aprovada (o campo "tecido" da OS está vazio)`
      : 'Não informado';
  let action: { label: string; run: () => void } | null = null;
  let actionNote: string | null = null;
  const firstMissing = missing.find((l) => l.shortfall > 0) ?? missing[0];
  if (firstMissing) {
    const ex = explain(firstMissing);
    const u = UNIT_LABEL[firstMissing.unit] ?? firstMissing.unit;
    if (ex.toReserve > 0 && ex.stockItemId && snapshot.canExecuteStock)
      action = {
        label: `Reservar ${fmtQty(ex.toReserve)} ${u} de ${firstMissing.description} do estoque`,
        run: () => reserve(firstMissing, ex.toReserve, ex.stockItemId!),
      };
    else if (ex.toBuy > 0)
      action = {
        label: `Comprar ${fmtQty(ex.toBuy)} ${u} de ${firstMissing.description}`,
        run: () =>
          window.open(
            `/painel/compras/novo?req=${firstMissing.requirementId}`,
            '_blank',
            'noopener',
          ),
      };
    else if (firstMissing.awaiting > 0)
      action = {
        label: `Registrar chegada de ${firstMissing.description}`,
        run: () => window.open('/painel/recebimento-materiais', '_blank', 'noopener'),
      };
    else actionNote = `${firstMissing.description}: aguardando compra em aberto ou reserva.`;
  } else if (wf.phase === 'AGUARDANDO_PLANEJAMENTO')
    action = snapshot.canPlan ? { label: 'Planejar a OS', run: () => setTab('ATRIBUICAO') } : null;
  else if (wf.phase === 'AGUARDANDO_PUBLICACAO' && snapshot.canPlan)
    action = { label: 'Colocar na fila (publicar a semana)', run: () => publish() };
  else if (wf.phase === 'PRONTA_ENTREGA' && onOpenFicha)
    action = { label: 'Ver saldo e entrega', run: onOpenFicha };
  if (!action && !actionNote) {
    if (wf.current)
      actionNote = `${wf.current.assignee ?? 'Responsável'} está em ${wf.current.label.toLowerCase()} (registrado no tablet).`;
    else if (wf.next?.available)
      actionNote = `Aguardando ${wf.next.assignee ?? 'o responsável'} iniciar ${wf.next.label.toLowerCase()} no tablet.`;
    else if (wf.next?.reason) actionNote = `Próxima etapa parada: ${wf.next.reason}.`;
  }
  const stageLabel = FULFILLMENT_STAGE_LABEL[piece.stage as FulfillmentStage] ?? piece.stage;

  return (
    <Panel
      testId="piece-panel"
      wrapTitle
      icon={MODEL_ICON[piece.model]}
      title={`${piece.itemCode} · ${piece.description}`}
      subtitle={
        <span>
          {piece.customerName ?? 'Cliente (sem permissão para ver)'} ·{' '}
          {SERVICE_LABEL[piece.serviceType] ?? piece.serviceType}
          {piece.quantity > 1 ? ` · ${piece.quantity} un.` : ''}
        </span>
      }
      onClose={onClose}
      className="h-full"
      actions={
        <>
          {onOpenFicha ? (
            <button
              type="button"
              onClick={onOpenFicha}
              data-testid="open-ficha"
              className="rounded-lg border border-bronze-500/40 px-2 py-1 text-xs font-semibold text-bronze-600 hover:bg-bronze-100"
              title="Contrato, entrada, saldo e nota"
            >
              💼 Ficha
            </button>
          ) : null}
          <a
            href={`/painel/os/${piece.serviceOrderId}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg p-1 text-ink-muted hover:bg-bronze-100"
            title="Abrir a OS no painel"
          >
            <ExternalLink className="size-5" />
          </a>
        </>
      }
    >
      {atShipping && balance.data && balance.data.balanceCents !== null ? (
        <button
          type="button"
          onClick={onOpenFicha}
          data-testid="shipping-balance"
          className={`mb-2 w-full rounded-xl border px-3 py-2 text-left text-xs font-semibold ${balance.data.balanceCents > 0 ? 'border-warn-600/40 bg-warn-50 text-warn-600' : 'border-ok-600/30 bg-ok-50 text-ok-600'}`}
        >
          {balance.data.balanceCents > 0
            ? `💰 Saldo a receber na entrega: ${(balance.data.balanceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
            : '💰 Pedido quitado — pode entregar'}
        </button>
      ) : null}
      <div
        className="mb-3 space-y-2 rounded-xl border-2 border-bronze-500/40 bg-white p-2.5"
        data-testid="piece-summary"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Tone tone={wf.tone}>
            <span data-testid="piece-phase">
              {wf.icon} {wf.phaseLabel}
            </span>
          </Tone>
          <Tone tone={piece.tone}>
            {piece.tone === 'FALTA' ? '⛔' : piece.tone === 'DISPONIVEL' ? '✅' : '❔'}{' '}
            {wf.material.label}
          </Tone>
          {piece.priority !== 'NORMAL' ? (
            <Tone tone={piece.priority === 'URGENTE' ? 'risco' : 'atencao'}>
              Prioridade {PRIORITY_LABEL[piece.priority]}
            </Tone>
          ) : null}
        </div>
        <div className="text-xs">
          <KV
            k={wf.running.length > 1 ? 'Etapas em execução' : 'Etapa atual'}
            v={
              wf.running.length ? (
                <span data-testid="piece-current">
                  {wf.running.map((r, i) => (
                    <span key={r.taskId} className="block">
                      {r.label} · {r.assignee ?? '—'} ·{' '}
                      {r.status === 'PAUSADA' ? 'pausada' : 'iniciada no tablet'}
                      {r.startedAt ? ` ${fmtDateTime(r.startedAt)}` : ''}
                      {i < wf.running.length - 1 ? '' : ''}
                    </span>
                  ))}
                </span>
              ) : (
                'Nenhuma etapa iniciada no tablet'
              )
            }
          />
          <KV
            k="Próxima etapa"
            v={
              wf.next ? (
                <span data-testid="piece-next">
                  {wf.next.label} · {wf.next.assignee ?? 'sem responsável'} ·{' '}
                  {wf.next.available ? (
                    <b className="text-ok-600">disponível no tablet</b>
                  ) : (
                    <b className="text-danger-700">
                      {wf.next.reason ?? TASK_STATUS_LABEL[wf.next.status]}
                    </b>
                  )}
                </span>
              ) : (
                '—'
              )
            }
          />
          <KV k="Responsável" v={wf.responsible ?? 'A definir'} />
          <KV k="Prazo" v={fmtDate(piece.promisedDate)} />
          <KV k="Estado geral da peça" v={wf.general} />
          <KV
            k="Estação da etapa (registros)"
            v={<span data-testid="piece-placement">{piece.placement.label}</span>}
          />
          <KV
            k="Posição física confirmada"
            v={
              piece.confirmedLocation ? (
                <span className="inline-flex items-center gap-1 text-info-600">
                  <MapPin className="size-3.5" /> {piece.confirmedLocation.label}
                  {piece.confirmedLocation.by ? ` · ${piece.confirmedLocation.by}` : ''} ·{' '}
                  {fmtDateTime(piece.confirmedLocation.at)}
                </span>
              ) : (
                'Nenhuma confirmada'
              )
            }
          />
        </div>
        {wf.blockedReason ? (
          <div
            className="rounded-lg bg-danger-50 p-1.5 text-xs text-danger-700"
            data-testid="piece-blocked"
          >
            ⛔ Bloqueio: {wf.blockedReason}
          </div>
        ) : null}
        {action ? (
          <GBtn
            tone="primary"
            className="w-full"
            onClick={action.run}
            testId="piece-next-action"
            disabled={busy}
          >
            {action.label}
          </GBtn>
        ) : actionNote ? (
          <p
            className="rounded-lg bg-subtle p-1.5 text-xs text-ink-soft"
            data-testid="piece-next-note"
          >
            {actionNote}
          </p>
        ) : null}
      </div>
      <div className="mb-2 flex flex-wrap gap-1" role="tablist">
        {(
          [
            ['MATERIAIS', `Materiais${missing.length ? ` (${missing.length} ⛔)` : ''}`],
            ['ATRIBUICAO', 'Atribuição e fila'],
            ['SERVICO', 'Serviço e fotos'],
            ['HISTORICO', 'Histórico'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            data-testid={`piece-tab-${k}`}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tab === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white'}`}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'SERVICO' ? (
        <>
          <Section title="Fotos">
            {allPhotos.length ? (
              <div className="grid grid-cols-3 gap-1.5">
                {allPhotos.slice(0, 9).map((p) => (
                  <a
                    key={p.id}
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block aspect-square overflow-hidden rounded-lg border border-line bg-subtle"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.url}
                      alt={p.caption ?? 'Foto da OS'}
                      className="size-full object-cover"
                    />
                  </a>
                ))}
              </div>
            ) : (
              <p className="text-xs text-ink-muted">
                {photosOs.isPending ? 'Carregando…' : 'Nenhuma foto cadastrada nesta OS.'}
              </p>
            )}
          </Section>
        </>
      ) : null}

      {tab === 'SERVICO' ? (
        <>
          <Section title="Serviço">
            <KV k="OS" v={piece.osCode} />
            <KV k="Prazo" v={fmtDate(piece.promisedDate)} />
            <KV k="Tecido" v={<span data-testid="piece-fabric">{fabricText}</span>} />
            <KV
              k="Responsável (titular)"
              v={
                piece.upholstererName ? (
                  <button
                    className="underline"
                    onClick={() => onFocusEmployee(piece.upholstererUserId!)}
                  >
                    {piece.upholstererName}
                  </button>
                ) : (
                  'A definir'
                )
              }
            />
            <KV
              k="Etapa atual"
              v={
                piece.currentTask
                  ? `${ACTIVITY_LABEL_GAME[piece.currentTask.activity] ?? piece.currentTask.activity} · ${piece.currentTask.assigneeName ?? '—'} (${TASK_STATUS_LABEL[piece.currentTask.status]})`
                  : stageLabel
              }
            />
            <KV
              k="Próxima etapa"
              v={
                piece.nextTask
                  ? `${ACTIVITY_LABEL_GAME[piece.nextTask.activity] ?? piece.nextTask.activity} · ${piece.nextTask.assigneeName ?? 'sem responsável'}`
                  : '—'
              }
            />
            {siblings.length > 1 ? (
              <KV k="Peças da mesma OS" v={siblings.map((s) => s.itemCode).join(', ')} />
            ) : null}
            {so.data?.technicalInstructions ? (
              <p className="mt-2 rounded-lg bg-subtle p-2 text-xs">
                {so.data.technicalInstructions}
              </p>
            ) : null}
          </Section>
        </>
      ) : null}

      {tab === 'MATERIAIS' ? (
        <>
          <Section title="Materiais">
            {readiness.isPending ? (
              <p className="text-xs text-ink-muted">Carregando…</p>
            ) : !lines.length ? (
              <Tone tone="A_CONFERIR">
                ❔ A conferir: ainda sem levantamento de materiais aprovado
              </Tone>
            ) : (
              <ul className="space-y-2" data-testid="piece-materials">
                {lines.map((l) => {
                  const t = lineTone(l);
                  return (
                    <li
                      key={l.requirementId}
                      className="rounded-lg border border-line bg-white p-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium">
                          {l.description}
                          {l.color ? ` · ${l.color}` : ''}
                          {l.foamDensity ? ` · ${l.foamDensity}` : ''}
                        </div>
                        <Tone tone={t.tone}>
                          {t.tone === 'DISPONIVEL' ? '✅' : t.tone === 'FALTA' ? '⛔' : '❔'}{' '}
                          {t.text}
                        </Tone>
                      </div>
                      {(() => {
                        const ex = explain(l);
                        const u = UNIT_LABEL[l.unit] ?? l.unit;
                        return (
                          <div
                            className="mt-1 grid grid-cols-2 gap-x-3 text-xs text-ink-soft"
                            data-testid="material-numbers"
                          >
                            <span>
                              Necessária:{' '}
                              <b>
                                {fmtQty(l.need)} {u}
                              </b>
                            </span>
                            <span>
                              {l.sourcing === 'EXCLUSIVO_OS'
                                ? 'Compra exclusiva da OS'
                                : 'Do estoque'}
                            </span>
                            {l.sourcing === 'ESTOQUE' ? (
                              <span>
                                Reservada p/ esta OS: <b>{fmtQty(l.reserved)}</b>
                              </span>
                            ) : (
                              <span>
                                Recebida: <b>{fmtQty(l.received)}</b>
                              </span>
                            )}
                            <span>
                              Comprada a caminho: <b>{fmtQty(l.awaiting)}</b>
                            </span>
                            {l.sourcing === 'ESTOQUE' ? (
                              <span>
                                Livre p/ reservar: <b>{ex.known ? fmtQty(ex.free) : '—'}</b>
                              </span>
                            ) : null}
                            {l.inDraft > 0 ? (
                              <span>
                                Em rascunho de compra: <b>{fmtQty(l.inDraft)}</b>
                              </span>
                            ) : null}
                            {l.covered < l.need - 1e-9 ? (
                              <span className="col-span-2 text-danger-700">
                                Restante a comprar:{' '}
                                <b>
                                  {fmtQty(ex.toBuy)} {u}
                                </b>
                                {ex.pending > 0
                                  ? ` (já descontada compra de estoque em aberto: ${fmtQty(ex.pending)})`
                                  : ''}
                              </span>
                            ) : null}
                          </div>
                        );
                      })()}
                      {l.covered < l.need - 1e-9 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(() => {
                            const ex = explain(l);
                            return ex.toReserve > 0 &&
                              ex.stockItemId &&
                              snapshot.canExecuteStock ? (
                              <button
                                className="rounded-lg bg-brand-600 px-2 py-1 text-xs font-semibold text-white"
                                disabled={busy}
                                data-testid="material-reserve"
                                onClick={() => reserve(l, ex.toReserve, ex.stockItemId!)}
                              >
                                Reservar {fmtQty(ex.toReserve)} do estoque
                              </button>
                            ) : null;
                          })()}
                          {explain(l).toBuy > 0 ? (
                            <a
                              data-testid="material-buy"
                              className="inline-flex items-center gap-1 rounded-lg bg-bronze-500 px-2 py-1 text-xs font-semibold text-white"
                              href={`/painel/compras/novo?req=${l.requirementId}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ShoppingCart className="size-3.5" /> Comprar{' '}
                              {fmtQty(explain(l).toBuy)}
                            </a>
                          ) : null}
                          {l.sourcing === 'ESTOQUE' ? (
                            <button
                              className="rounded-lg border border-line-strong px-2 py-1 text-xs font-semibold"
                              onClick={() => onLocateMaterial(l.description)}
                            >
                              Procurar no estoque do mapa
                            </button>
                          ) : null}
                          {l.awaiting > 0 ? (
                            <a
                              className="rounded-lg border border-line-strong px-2 py-1 text-xs font-semibold"
                              href="/painel/recebimento-materiais"
                              target="_blank"
                              rel="noreferrer"
                            >
                              Registrar chegada
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {missing.length ? (
              <p className="mt-2 text-xs text-danger-700">
                ⛔ {missing.length} material(is) pendente(s) segura(m) as etapas que dependem deles.
              </p>
            ) : null}
          </Section>
        </>
      ) : null}

      {tab === 'ATRIBUICAO' ? (
        <>
          <Section title="Atribuição e fila">
            {!piece.planned ? (
              snapshot.canPlan ? (
                <div
                  className="space-y-2 rounded-xl border border-line bg-white p-2.5"
                  data-testid="plan-form"
                >
                  <p className="text-xs text-ink-soft">
                    Planejar segue a regra oficial: o titular de cada peça faz corte e costura; o
                    desmanche vai para o responsável padrão da preparação.
                  </p>
                  {siblings.map((s) => (
                    <label key={s.id} className="flex items-center justify-between gap-2 text-xs">
                      <span>
                        {s.itemCode} · {s.description}
                      </span>
                      <select
                        className="rounded-lg border border-line-strong px-2 py-1"
                        value={plan.owners[s.id] ?? ''}
                        onChange={(e) =>
                          setPlan((p) => ({
                            ...p,
                            owners: { ...p.owners, [s.id]: e.target.value },
                          }))
                        }
                      >
                        <option value="">(sem tapeçaria)</option>
                        {upholsterers.map((u) => (
                          <option key={u.userId} value={u.userId}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <div className="flex gap-2 text-xs">
                    <label className="flex-1">
                      Início
                      <input
                        type="date"
                        className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1"
                        value={plan.startDate}
                        onChange={(e) => setPlan((p) => ({ ...p, startDate: e.target.value }))}
                      />
                    </label>
                    <label className="flex-1">
                      Prioridade
                      <select
                        className="mt-0.5 w-full rounded-lg border border-line-strong px-2 py-1"
                        value={plan.priority}
                        onChange={(e) => setPlan((p) => ({ ...p, priority: e.target.value }))}
                      >
                        {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <GBtn
                    tone="primary"
                    disabled={busy}
                    onClick={planService}
                    className="w-full"
                    testId="plan-service"
                  >
                    Planejar serviço
                  </GBtn>
                </div>
              ) : (
                <p className="text-xs text-ink-muted">
                  Sua conta não planeja produção (producao.planejar).
                </p>
              )
            ) : (
              <>
                {draftPlanId && snapshot.canPlan ? (
                  <div className="mb-2 rounded-xl border border-warn-600/30 bg-warn-50 p-2 text-xs">
                    Etapas em rascunho: ainda não aparecem nos tablets.
                    <GBtn
                      tone="bronze"
                      disabled={busy}
                      onClick={publish}
                      className="mt-1.5 w-full"
                      testId="publish-week"
                    >
                      Colocar na fila (publicar a semana)
                    </GBtn>
                  </div>
                ) : null}
                <ol className="space-y-1.5" data-testid="piece-steps">
                  {piece.tasks.map((t) => {
                    const locked = ['EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA', 'CANCELADA'].includes(
                      t.status,
                    );
                    return (
                      <li
                        key={t.id}
                        className="flex items-center gap-2 rounded-lg border border-line bg-white px-2 py-1.5 text-xs"
                      >
                        <span
                          className={
                            t.status === 'CONCLUIDA'
                              ? 'text-ok-600'
                              : t.status === 'EM_EXECUCAO'
                                ? 'text-brand-600'
                                : 'text-ink-muted'
                          }
                        >
                          {t.status === 'CONCLUIDA'
                            ? '✔'
                            : t.status === 'EM_EXECUCAO'
                              ? '▶'
                              : t.status === 'PAUSADA'
                                ? '⏸'
                                : '•'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold">
                            {t.title.replace(/\s+—\s+OS-[\d/]+$/, '')}
                          </div>
                          <div className="text-ink-muted">
                            {(() => {
                              const st = wf.steps.find((s) => s.taskId === t.id);
                              if (t.status === 'LIBERADA') return '✅ Disponível no tablet';
                              return `${TASK_STATUS_LABEL[t.status] ?? t.status}${st?.reason ? ` · ${st.reason}` : ''}`;
                            })()}
                          </div>
                        </div>
                        {snapshot.canPlan && !locked ? (
                          <select
                            aria-label={`Responsável por ${t.title}`}
                            className="max-w-28 rounded-lg border border-line-strong px-1 py-0.5"
                            disabled={busy}
                            value={t.assigneeUserId ?? ''}
                            onChange={(e) =>
                              reassign(t.id, t.version, e.target.value, t.status !== 'RASCUNHO')
                            }
                          >
                            <option value="">Sem responsável</option>
                            {workers.map((w) => (
                              <option key={w.userId} value={w.userId}>
                                {w.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="font-medium">{t.assigneeName ?? '—'}</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-2 text-xs text-ink-muted">
                  O início é sempre confirmado pelo funcionário no tablet (Iniciar). Uma tarefa em
                  execução por pessoa.
                </p>
              </>
            )}
          </Section>
        </>
      ) : null}

      {tab === 'HISTORICO' ? (
        <>
          <Section
            title="Histórico"
            right={
              <button className="text-xs underline" onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? 'Ocultar' : 'Mostrar'}
              </button>
            }
          >
            {showHistory ? (
              <History
                taskIds={piece.tasks
                  .filter((t) => t.startedAt || t.completedAt || t.status !== 'RASCUNHO')
                  .map((t) => t.id)
                  .slice(0, 12)}
              />
            ) : (
              <p className="text-xs text-ink-muted">
                Início, pausas, conclusões e trocas de responsável das etapas.
              </p>
            )}
          </Section>
        </>
      ) : null}
    </Panel>
  );
}

function History({ taskIds }: { taskIds: string[] }) {
  const qs = useQueries({
    queries: taskIds.map((id) => ({
      queryKey: ['production-task', id],
      queryFn: () => api<ProductionTaskDetailDto>(`/api/v1/production-tasks/${id}`),
    })),
  });
  const events = useMemo(
    () =>
      qs
        .flatMap((q) => (q.data ? q.data.events.map((e) => ({ ...e, title: q.data!.title })) : []))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [qs],
  );
  if (qs.some((q) => q.isPending)) return <p className="text-xs text-ink-muted">Carregando…</p>;
  if (!events.length) return <p className="text-xs text-ink-muted">Sem registros ainda.</p>;
  return (
    <ul className="space-y-1 text-xs">
      {events.slice(0, 30).map((e) => (
        <li key={e.id} className="flex gap-2">
          <span className="shrink-0 text-ink-muted">{fmtDateTime(e.createdAt)}</span>
          <span>
            <b>{e.title}</b>: {e.kind.toLowerCase().replace(/_/g, ' ')}
            {e.toStatus ? ` → ${TASK_STATUS_LABEL[e.toStatus] ?? e.toStatus}` : ''}
            {e.actor ? ` · ${e.actor}` : ''}
            {e.note ? ` (${e.note})` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
