'use client';
/**
 * Atualizações do Cenário Gestão no Firma Viva: consulta periódica dos eventos oficiais
 * (/api/sync/events, repassado pela API do jogo com a autorização da organização). Mesma
 * interface do provedor de tempo real que o jogo já usa.
 */
import type { RealtimeEvent } from '@cenario/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from './api';

export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'ended';
type Listener = (event: RealtimeEvent, replayed: boolean) => void;

interface RealtimeState {
  status: ConnectionStatus;
  subscribe(listener: Listener): () => void;
  reconnectNow(): void;
}
const Ctx = createContext<RealtimeState | null>(null);
const POLL_MS = 3000;

export function RealtimeProvider({
  children,
  enabled,
  onSessionEnded,
}: {
  children: React.ReactNode;
  /** Só com o Cenário Gestão conectado; sem conexão a planta é local e fica "online". */
  enabled: boolean;
  onSessionEnded?: () => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus>(enabled ? 'connecting' : 'online');
  const listeners = useRef(new Set<Listener>());
  const since = useRef<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        if (since.current === null) {
          const s = await api<{ headSeq: string }>('/api/sync/status');
          since.current = s.headSeq;
        } else {
          let more = true;
          while (more && !stop) {
            const r: { events: RealtimeEvent[]; hasMore: boolean; nextSince: string } = await api(
              `/api/sync/events?since=${since.current}&limit=200`,
            );
            for (const e of r.events) for (const l of listeners.current) l(e, false);
            since.current = r.nextSince;
            more = r.hasMore;
          }
        }
        if (!stop) setStatus('online');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          onSessionEnded?.();
          setStatus('ended');
          return;
        }
        if (!stop) setStatus('reconnecting');
      }
      if (!stop) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, nonce, onSessionEnded]);

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);
  // Sem conexão com o Cenário a planta é local: sempre "online".
  const shown: ConnectionStatus = enabled ? status : 'online';
  const value = useMemo(
    () => ({ status: shown, subscribe, reconnectNow: () => setNonce((n) => n + 1) }),
    [shown, subscribe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeState {
  const v = useContext(Ctx);
  if (!v) throw new Error('RealtimeProvider ausente.');
  return v;
}
