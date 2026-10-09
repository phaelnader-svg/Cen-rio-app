'use client';

import type { RealtimeEvent, ServerMessage } from '@cenario/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'ended';

export interface RealtimeStats {
  received: number;
  reconnects: number;
  lastReplayCount: number;
  totalReplayed: number;
  resyncs: number;
  connectedAt: string | null;
  lastEventAt: string | null;
}

interface RealtimeState {
  status: ConnectionStatus;
  lastSeq: string | null;
  stats: RealtimeStats;
  subscribe(listener: (event: RealtimeEvent, replayed: boolean) => void): () => void;
  /** Força queda e reconexão (diagnóstico). */
  reconnectNow(): void;
}

const RealtimeContext = createContext<RealtimeState | null>(null);

/** Quais consultas são invalidadas por cada tipo de evento. */
function invalidate(qc: QueryClient, event: RealtimeEvent) {
  const keys: string[][] = [['dashboard'], ['audit']];
  const t = event.type;
  if (t.startsWith('employee.')) keys.push(['employees'], ['me'], ['tablet-status'], ['devices']);
  if (t.startsWith('role.')) keys.push(['roles'], ['employees'], ['me'], ['tablet-status']);
  if (t.startsWith('device.')) keys.push(['devices'], ['sessions'], ['tablet-status']);
  if (t.startsWith('session.')) keys.push(['sessions'], ['devices']);
  if (t.startsWith('company.')) keys.push(['company'], ['me']);
  // Fase 2 — fluxo comercial → oficina
  const flow = [
    ['orders'],
    ['order'],
    ['pickups'],
    ['pickup'],
    ['receipts'],
    ['receipts-pending'],
    ['so-available'],
  ];
  if (t.startsWith('customer.')) keys.push(['customers'], ['customer'], ['customer-lookup']);
  if (t.startsWith('order.') || t.startsWith('pickup.') || t.startsWith('receipt.'))
    keys.push(...flow, ['customer']);
  if (t.startsWith('service_order.')) keys.push(['service-orders'], ['service-order'], ...flow);
  if (t === 'attachment.changed') keys.push(['attachments']);
  // Fase 3 — medições e solicitações de materiais
  if (t.startsWith('measurement.') || t.startsWith('material_request.')) {
    keys.push(
      ['measurements'],
      ['measurement'],
      ['my-measurements'],
      ['measurements-awaiting'],
      ['planning'],
      ['consolidated'],
      ['service-order'],
    );
  }
  // Fase 4 — compras, recebimento, estoque e prontidão
  const purchasing = [
    ['needs'],
    ['purchase-orders'],
    ['purchase-order'],
    ['pending-receipts'],
    ['stock-items'],
    ['stock-movements'],
    ['stock-reservations'],
    ['leftovers'],
    ['readiness'],
    ['os-readiness'],
    ['service-order'],
  ];
  if (
    ['supplier.', 'purchase_order.', 'material.', 'material_receipt.', 'stock.', 'leftover.'].some(
      (p) => t.startsWith(p),
    )
  )
    keys.push(['suppliers'], ...purchasing);
  if (t.startsWith('measurement.') || t.startsWith('material_request.'))
    keys.push(['needs'], ['readiness'], ['os-readiness']);
  // Fase 5 — produção
  if (t.startsWith('production.') || t === 'material.readiness_changed') {
    keys.push(
      ['production-plans'],
      ['production-plan'],
      ['production-candidates'],
      ['production-board'],
      ['production-task'],
      ['my-tasks'],
      ['my-queue'],
      ['production-queue'],
      ['os-production'],
    );
  }
  if (t === 'production.template_changed') keys.push(['production-templates']);
  // Fase 6 — notificações (só chegam ao destinatário). Uma atualização da OS também
  // recarrega o detalhe técnico aberto no tablet.
  if (t.startsWith('notification.')) keys.push(['notifications']);
  // Fase 7 — presença operacional (e disponibilidade, que depende das tarefas).
  if (t.startsWith('attendance.') || t.startsWith('production.task_')) {
    keys.push(
      ['attendance-me'],
      ['attendance-team'],
      ['attendance-impacts'],
      ['attendance-history'],
    );
  }
  if (t === 'notification.created') keys.push(['production-task'], ['my-tasks']);
  // Fase 8 — ajuda, reprogramação e histórico do planejamento.
  if (t.startsWith('help.') || t.startsWith('production.task_')) {
    keys.push(['help-requests'], ['help-request'], ['my-help'], ['skills'], ['alternatives']);
  }
  if (t.startsWith('help.') || t.startsWith('reschedule.') || t.startsWith('planning.')) {
    keys.push(['reschedule-proposals'], ['planning-actions'], ['my-tasks'], ['production-board']);
  }
  if (t.startsWith('attendance.')) keys.push(['reschedule-proposals'], ['help-requests']);
  // Fase 9 — ocorrências e central de atenção (exceções vindas de vários módulos).
  if (t.startsWith('issue.')) {
    keys.push(
      ['issues'],
      ['issue'],
      ['my-issues'],
      ['issue-impacts'],
      ['my-tasks'],
      ['production-task'],
    );
  }
  if (
    ['issue.', 'help.', 'reschedule.', 'attendance.', 'production.task_'].some((p) =>
      t.startsWith(p),
    )
  ) {
    keys.push(['attention'], ['help-candidates']);
  }
  if (t === 'attachment.changed') keys.push(['issue']);
  // Fase 10 — qualidade, embalagem, expedição, entregas, logística e devoluções.
  const quality = [
    ['inspections'],
    ['inspection'],
    ['packaging'],
    ['pieces'],
    ['piece'],
    ['deliveries'],
    ['delivery'],
    ['logistics-jobs'],
    ['logistics-occurrences'],
    ['logistics-occurrence'],
    ['returns'],
    ['locations'],
    ['attention'],
  ];
  if (
    ['quality.', 'packaging.', 'item.', 'delivery.', 'logistics.', 'return.'].some((p) =>
      t.startsWith(p),
    ) ||
    t.startsWith('production.task_') ||
    t === 'pickup.updated' ||
    t === 'pickup.status_changed'
  )
    keys.push(...quality, ['my-tasks'], ['production-task'], ['fin']);
  if (t === 'notification.created') keys.push(['inspections'], ['packaging'], ['logistics-jobs']);
  if (t === 'quality.template_changed') keys.push(['quality-templates']);
  // Fase 11: eventos financeiros (sem valores) só chegam a quem vê o financeiro.
  if (t.startsWith('finance.')) keys.push(['fin']);
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

const PING_INTERVAL = 20_000;
const PONG_TIMEOUT = 10_000;

export function RealtimeProvider({
  children,
  onSessionEnded,
}: {
  children: React.ReactNode;
  onSessionEnded: (reason: string) => void;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [lastSeq, setLastSeq] = useState<string | null>(null);
  const [stats, setStats] = useState<RealtimeStats>({
    received: 0,
    reconnects: 0,
    lastReplayCount: 0,
    totalReplayed: 0,
    resyncs: 0,
    connectedAt: null,
    lastEventAt: null,
  });

  const seqRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const endedRef = useRef(false);
  const replayingRef = useRef(false);
  const timers = useRef<{ retry?: number; ping?: number; pong?: number }>({});
  const listeners = useRef(new Set<(e: RealtimeEvent, replayed: boolean) => void>());
  /** Sockets descartados intencionalmente (desmontagem) não disparam reconexão. */
  const disposed = useRef(new WeakSet<WebSocket>());
  const onEndedRef = useRef(onSessionEnded);
  const connectRef = useRef<() => void>(() => {});
  useEffect(() => {
    onEndedRef.current = onSessionEnded;
  }, [onSessionEnded]);

  const connect = useCallback(() => {
    if (endedRef.current) return;
    const existing = wsRef.current;
    if (existing && existing.readyState <= WebSocket.OPEN) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/realtime`);
    wsRef.current = ws;
    setStatus(attemptRef.current === 0 && seqRef.current === null ? 'connecting' : 'reconnecting');

    const clearPing = () => {
      window.clearInterval(timers.current.ping);
      window.clearTimeout(timers.current.pong);
    };

    ws.onopen = () => {
      timers.current.ping = window.setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ kind: 'ping', t: Date.now() }));
        window.clearTimeout(timers.current.pong);
        // Sem resposta: conexão "zumbi" (comum em Wi-Fi instável). Força reconexão.
        timers.current.pong = window.setTimeout(() => ws.close(4000, 'pong timeout'), PONG_TIMEOUT);
      }, PING_INTERVAL);
    };

    ws.onmessage = (raw) => {
      if (disposed.current.has(ws)) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(raw.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.kind) {
        case 'hello': {
          const isFirst = seqRef.current === null;
          replayingRef.current = !isFirst;
          ws.send(JSON.stringify({ kind: 'resume', sinceSeq: seqRef.current }));
          if (isFirst) {
            // Primeira conexão: garante que os dados carregados reflitam tudo até agora.
            seqRef.current = msg.headSeq;
            setLastSeq(msg.headSeq);
            void qc.invalidateQueries();
          }
          if (attemptRef.current > 0) setStats((s) => ({ ...s, reconnects: s.reconnects + 1 }));
          attemptRef.current = 0;
          setStatus('online');
          setStats((s) => ({ ...s, connectedAt: new Date().toISOString() }));
          break;
        }
        case 'event': {
          seqRef.current = msg.event.seq;
          setLastSeq(msg.event.seq);
          invalidate(qc, msg.event);
          const replayed = replayingRef.current;
          setStats((s) => ({
            ...s,
            received: s.received + 1,
            lastEventAt: new Date().toISOString(),
          }));
          for (const l of listeners.current) l(msg.event, replayed);
          break;
        }
        case 'replay.done':
          replayingRef.current = false;
          seqRef.current = msg.toSeq;
          setLastSeq(msg.toSeq);
          setStats((s) => ({
            ...s,
            lastReplayCount: msg.count,
            totalReplayed: s.totalReplayed + msg.count,
          }));
          break;
        case 'resync.required':
          // Intervalo grande demais (ou banco restaurado): recarrega tudo do servidor.
          replayingRef.current = false;
          seqRef.current = msg.headSeq;
          setLastSeq(msg.headSeq);
          setStats((s) => ({ ...s, resyncs: s.resyncs + 1 }));
          void qc.invalidateQueries();
          break;
        case 'pong':
          window.clearTimeout(timers.current.pong);
          break;
        case 'session.ended':
          endedRef.current = true;
          setStatus('ended');
          onEndedRef.current(msg.reason);
          break;
      }
    };

    ws.onclose = (ev) => {
      clearPing();
      if (wsRef.current === ws) wsRef.current = null;
      if (endedRef.current || disposed.current.has(ws)) return;
      if (ev.code === 4401) {
        endedRef.current = true;
        setStatus('ended');
        onEndedRef.current('revoked');
        return;
      }
      setStatus(navigator.onLine ? 'reconnecting' : 'offline');
      const attempt = ++attemptRef.current;
      const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 400;
      window.clearTimeout(timers.current.retry);
      timers.current.retry = window.setTimeout(() => connectRef.current(), delay);
    };
  }, [qc]);

  const reconnectNow = useCallback(() => {
    attemptRef.current = Math.max(attemptRef.current, 1);
    wsRef.current?.close(4001, 'manual');
  }, []);

  useEffect(() => {
    connectRef.current = connect;
    const disposedSet = disposed.current;
    endedRef.current = false;
    // Sincroniza com um sistema externo (WebSocket): é exatamente o papel deste efeito.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    connect();
    const wake = () => {
      if (!wsRef.current) {
        window.clearTimeout(timers.current.retry);
        connect();
      }
    };
    // A rede voltou: o socket antigo pode ter sobrevivido à queda sem fechar ("zumbi", que só
    // seria detectado no próximo ping, até 30 s depois). Troca por uma conexão nova na hora; o
    // "resume" pela última sequência recupera os eventos perdidos.
    const onOnline = () => {
      const old = wsRef.current;
      if (old && !endedRef.current) {
        disposedSet.add(old);
        wsRef.current = null;
        window.clearInterval(timers.current.ping);
        window.clearTimeout(timers.current.pong);
        old.close(4002, 'network back');
      }
      wake();
    };
    const onVisible = () => document.visibilityState === 'visible' && wake();
    const onOffline = () => setStatus((s) => (s === 'ended' ? s : 'offline'));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const t = timers.current;
    return () => {
      endedRef.current = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(t.retry);
      window.clearInterval(t.ping);
      window.clearTimeout(t.pong);
      if (wsRef.current) {
        disposedSet.add(wsRef.current);
        wsRef.current.close(1000, 'unmount');
      }
      wsRef.current = null;
    };
  }, [connect]);

  const subscribe = useCallback((listener: (e: RealtimeEvent, replayed: boolean) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo(
    () => ({ status, lastSeq, stats, subscribe, reconnectNow }),
    [status, lastSeq, stats, subscribe, reconnectNow],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeState {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime fora do RealtimeProvider');
  return ctx;
}
