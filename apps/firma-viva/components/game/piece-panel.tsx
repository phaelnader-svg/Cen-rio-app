'use client';
/**
 * Ficha da OS ao clicar no móvel. Tudo vem das rotas oficiais (OS, materiais, fotos, tarefas) e
 * as ações usam os mesmos fluxos do painel: planejar serviço (titular + data), publicar a semana
 * (a tarefa vai para a fila do tablet), trocar o responsável de uma etapa com motivo e versão.
 * O início continua sendo confirmado pelo funcionário no tablet.
 */
import { Ic, iconText } from './icons';
import {
  ACTIVITY_LABEL_GAME,
  FULFILLMENT_STAGE_LABEL,
  type FulfillmentStage,
  type GamePieceDto,
  type GameSnapshotDto,
  type ProductionPlanDto,
  type ProductionTaskDetailDto,
  type OsMaterialDto,
  pieceWorkflow,
} from '@cenario/shared';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MapPin } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { type GamePerson, useOsMaterials, usePhotos, useServiceOrder } from './game-api';
import {
  GBtn,
  KV,
  Panel,
  Section,
  TASK_STATUS_LABEL,
  Tone,
  fmtDate,
  fmtDateTime,
  fmtQty,
} from './ui';
import { cenarioUrl } from '@/lib/links';

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

/** Lista simples de materiais da OS: só informativa, nunca segura a produção. */
function lineTone(l: OsMaterialDto): { tone: 'FALTA' | 'DISPONIVEL' | 'A_CONFERIR'; text: string } {
  if (l.available) return { tone: 'DISPONIVEL', text: 'Disponível na oficina' };
  if (l.purchased) return { tone: 'A_CONFERIR', text: 'Comprado, a caminho' };
  return { tone: 'FALTA', text: 'A comprar' };
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
  const materials = useOsMaterials(piece.serviceOrderId);
  const photosOs = usePhotos('SERVICE_ORDER', piece.serviceOrderId);
  const photosItem = usePhotos('SERVICE_ORDER_ITEM', piece.id);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  /** Recusa da última ação (ex.: outra OS reservou a última unidade): fica visível até a próxima. */
  const [lastError, setLastError] = useState<string | null>(null);
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
      qc.invalidateQueries({ queryKey: ['game-os-materials', piece.serviceOrderId] }),
      // Estoque livre e compras de estoque (mesma fonte da central de compras).
      qc.invalidateQueries({ queryKey: ['needs'] }),
    ]);
  };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setLastError(null);
    try {
      await fn();
      toast('ok', label);
      await refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente de novo.';
      toast('danger', msg);
      setLastError(msg);
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
  const lines = materials.data?.materials ?? [];
  /** Marca comprado / na oficina pela rota oficial da lista da OS (quem gerencia OS). */
  const markLine = async (
    l: OsMaterialDto,
    patch: { purchased?: boolean; available?: boolean },
  ) => {
    try {
      await api(`/api/v1/service-orders/${piece.serviceOrderId}/material-list/${l.id}`, {
        method: 'PATCH',
        idempotencyKey: newIdempotencyKey(),
        body: { ...patch, version: l.version },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['game-os-materials', piece.serviceOrderId] }),
        qc.invalidateQueries({ queryKey: ['game-snapshot'] }),
      ]);
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível marcar.');
    }
  };
  const missing = lines.filter((l) => !l.available);
  const wf = pieceWorkflow(piece);
  const [tab, setTab] = useState<'MATERIAIS' | 'ATRIBUICAO' | 'SERVICO' | 'HISTORICO'>('MATERIAIS');
  const fabricText = piece.fabric ? piece.fabric : 'Não informado';
  let action: { label: string; run: () => void } | null = null;
  let actionNote: string | null = null;
  const firstMissing = missing[0];
  if (wf.phase === 'AGUARDANDO_PLANEJAMENTO' && firstMissing && !snapshot.canPlan) {
    actionNote = `${firstMissing.description}: ainda não disponível na oficina (não segura a produção).`;
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
              <Ic e="💼" /> Ficha
            </button>
          ) : null}
          <a
            href={cenarioUrl(`/painel/os/${piece.serviceOrderId}`)}
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
          {iconText(
            balance.data.balanceCents > 0
              ? `💰 Saldo a receber na entrega: ${(balance.data.balanceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
              : '💰 Pedido quitado — pode entregar',
          )}
        </button>
      ) : null}
      <div
        className="mb-3 space-y-2 rounded-xl border-2 border-bronze-500/40 bg-white p-2.5"
        data-testid="piece-summary"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Tone tone={wf.tone}>
            <span data-testid="piece-phase">
              <Ic e={wf.icon} /> {wf.phaseLabel}
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
        {lastError ? (
          <div
            className="rounded-lg border border-danger-600/30 bg-danger-50 p-1.5 text-xs text-danger-700"
            data-testid="piece-error"
          >
            <Ic e="⚠️" /> Não foi feito: {lastError} Os números abaixo já foram atualizados.
          </div>
        ) : null}
        {wf.blockedReason ? (
          <div
            className="rounded-lg bg-danger-50 p-1.5 text-xs text-danger-700"
            data-testid="piece-blocked"
          >
            <Ic e="⛔" /> Bloqueio: {wf.blockedReason}
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
            ['MATERIAIS', `Materiais${missing.length ? ` (${missing.length} pendente(s))` : ''}`],
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
            {iconText(l)}
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
            {materials.isPending ? (
              <p className="text-xs text-ink-muted">Carregando…</p>
            ) : !lines.length ? (
              <Tone tone="A_CONFERIR">❔ Nenhum material listado nesta OS</Tone>
            ) : (
              <ul className="space-y-2" data-testid="piece-materials">
                {lines.map((l) => {
                  const t = lineTone(l);
                  return (
                    <li key={l.id} className="rounded-lg border border-line bg-white p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium">
                          {l.description}
                          {l.quantity !== null
                            ? ` · ${fmtQty(l.quantity)}${l.unit ? ` ${l.unit}` : ''}`
                            : ''}
                        </div>
                        <Tone tone={t.tone}>
                          {t.tone === 'DISPONIVEL' ? '✅' : t.tone === 'FALTA' ? '⛔' : '❔'}{' '}
                          {t.text}
                        </Tone>
                      </div>
                      {l.notes ? <p className="mt-1 text-xs text-ink-soft">{l.notes}</p> : null}
                      {!l.available ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {snapshot.canPlan && !l.purchased ? (
                            <button
                              className="rounded-lg border border-line-strong px-2 py-1 text-xs font-semibold"
                              onClick={() => void markLine(l, { purchased: true })}
                              data-testid="material-mark-purchased"
                            >
                              Marcar comprado
                            </button>
                          ) : null}
                          {snapshot.canPlan ? (
                            <button
                              className="rounded-lg border border-line-strong px-2 py-1 text-xs font-semibold"
                              onClick={() => void markLine(l, { available: true })}
                              data-testid="material-mark-available"
                            >
                              Chegou na oficina
                            </button>
                          ) : null}
                          <button
                            className="rounded-lg border border-line-strong px-2 py-1 text-xs font-semibold"
                            onClick={() => onLocateMaterial(l.description)}
                          >
                            Procurar no estoque do mapa
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {missing.length ? (
              <p className="mt-2 text-xs text-ink-soft">
                {missing.length} material(is) ainda não chegou(aram). A produção não espera por
                eles. O agente de Compras, no escritório, prepara o pedido de cada fornecedor pelo
                WhatsApp.
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
                          {iconText(
                            t.status === 'CONCLUIDA'
                              ? '✔'
                              : t.status === 'EM_EXECUCAO'
                                ? '▶'
                                : t.status === 'PAUSADA'
                                  ? '⏸'
                                  : '•',
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold">
                            {t.title.replace(/\s+—\s+OS-[\d/]+$/, '')}
                          </div>
                          <div className="text-ink-muted">
                            {iconText(
                              (() => {
                                const st = wf.steps.find((s) => s.taskId === t.id);
                                if (t.status === 'LIBERADA') return '✅ Disponível no tablet';
                                return `${TASK_STATUS_LABEL[t.status] ?? t.status}${st?.reason ? ` · ${st.reason}` : ''}`;
                              })(),
                            )}
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
