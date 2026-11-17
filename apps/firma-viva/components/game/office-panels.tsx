'use client';
/**
 * Escritório: Central de Conexões, caixa de entrada (WhatsApp, Instagram, Messenger),
 * publicações do Marketing e campanhas do Tráfego. Tudo usa as rotas oficiais da API; as
 * credenciais ficam no servidor e nada é enviado/publicado/alterado sem a ação do gestor.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { Ic } from './icons';
import { GBtn, KV, Panel, Section, Tone, fmtDateTime } from './ui';
import { cenarioUrl } from '@/lib/links';

export interface ConnectionCard {
  key: string;
  label: string;
  group: string;
  provider: string;
  auth: 'SESSAO' | 'META_OAUTH' | 'API_KEY' | 'IMPORTACAO' | 'PLANEJADA';
  capabilities: string[];
  scopes: string[];
  status: string;
  mode: 'TESTE_LOCAL' | 'PRODUCAO' | 'IMPORTACAO' | null;
  verified: { tested: string[]; pending: string[] };
  /** sim = integração real ativa; teste = conta de teste local; parcial = conectada sem emissão real. */
  realIntegration: 'sim' | 'teste' | 'parcial' | 'nao';
  accountLabel: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  missing: { name: string; what: string }[];
  external: string[];
  docsUrl: string;
  testModeAvailable: boolean;
  pendingAccounts: {
    pages: { id: string; name: string; instagram: { id: string; username: string } | null }[];
    wabas: { id: string; name: string; phones: { id: string; display: string }[] }[];
    adAccounts: { id: string; name: string }[];
  } | null;
  company?: { name: string | null; document: string | null } | null;
  /** Conexão da organização no Firma Viva (autorização delegada do Cenário Gestão). */
  firma?: {
    status: string;
    company: { name: string; document: string | null } | null;
    cenarioUser: { name: string; email: string | null } | null;
    scopes: string[];
    permissions: string[];
    connectedAt: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
    canManage: boolean;
  };
  user?: { displayName: string; email: string };
  permissions?: number;
}
export interface InboxRow {
  id: string;
  channel: 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER';
  contactName: string | null;
  contactHandle: string | null;
  status: string;
  unread: number;
  summary: string | null;
  humanTakeover: boolean;
  lastMessageAt: string | null;
  lastText: string | null;
  customerName: string | null;
  osNumber: number | null;
}
interface InboxDetail {
  id: string;
  channel: InboxRow['channel'];
  contactName: string | null;
  contactHandle: string | null;
  status: string;
  summary: string | null;
  humanTakeover: boolean;
  customer: { id: string; name: string } | null;
  serviceOrder: { id: string; number: number } | null;
  connection: { status: string; mode: string; accountLabel: string | null } | null;
  rule: { free: boolean; needsTemplate: boolean; blocked: boolean; detail: string };
  messages: {
    id: string;
    direction: 'IN' | 'OUT';
    kind: string;
    text: string | null;
    media: { url?: string; mime?: string; caption?: string }[] | null;
    status: string;
    error: string | null;
    agent: string | null;
    createdBy: string | null;
    approvedBy: string | null;
    at: string;
  }[];
}

export const useConnections = () =>
  useQuery({
    queryKey: ['connections'],
    queryFn: () => api<ConnectionCard[]>('/api/v1/connections'),
    staleTime: 30_000,
  });
export const useInbox = (enabled: boolean) =>
  useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<InboxRow[]>('/api/v1/inbox'),
    enabled,
    refetchInterval: 30_000,
  });

export const CHANNEL: Record<string, { label: string; icon: string; cls: string }> = {
  WHATSAPP: {
    label: 'WhatsApp',
    icon: '🟢',
    cls: 'bg-emerald-50 text-emerald-700 border-emerald-600/30',
  },
  INSTAGRAM: {
    label: 'Instagram',
    icon: '📸',
    cls: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-600/30',
  },
  MESSENGER: { label: 'Messenger', icon: '💬', cls: 'bg-sky-50 text-sky-700 border-sky-600/30' },
};
const STATUS_LABEL: Record<string, string> = {
  CONECTADA: 'Conectada',
  DESCONECTADA: 'Desconectada',
  PENDENTE: 'Escolher conta',
  ERRO: 'Erro',
  PLANEJADA: 'Planejada',
  EXPIRADA: 'Expirada — reconectar',
  REVOGADA: 'Revogada — reconectar',
};
const CONV_STATUS: Record<string, string> = {
  ABERTA: 'Aberta',
  AGUARDANDO_ORCAMENTO: 'Esperando orçamento',
  EM_ATENDIMENTO: 'Em atendimento',
  ENCERRADA: 'Encerrada',
};
const MSG_STATUS: Record<string, string> = {
  RECEBIDA: 'recebida',
  RASCUNHO: 'rascunho do agente',
  ENVIADA: 'enviada',
  ENVIADA_TESTE: 'enviada (teste)',
  FALHOU: 'falhou',
  DESCARTADA: 'descartada',
};
const GROUPS: [string, string][] = [
  ['SISTEMA', 'Cenário Gestão'],
  ['META', 'Canais e anúncios (Meta)'],
  ['DOCUMENTOS', 'Documentos e fiscal'],
  ['FINANCEIRO', 'Financeiro'],
  ['OPERACAO', 'Operação'],
  ['GOOGLE', 'Próximas conexões'],
];

export function ChannelBadge({ channel }: { channel: string }) {
  const c = CHANNEL[channel] ?? {
    label: channel,
    icon: '•',
    cls: 'bg-subtle text-ink border-line',
  };
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-bold',
        c.cls,
      )}
    >
      <Ic e={c.icon} /> {c.label}
    </span>
  );
}

function useAct() {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(path: string, body: unknown = {}, ok?: string): Promise<T | null> => {
    try {
      const r = await api<T>(path, { method: 'POST', idempotencyKey: newIdempotencyKey(), body });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['connections'] }),
        qc.invalidateQueries({ queryKey: ['inbox'] }),
        qc.invalidateQueries({ queryKey: ['inbox-conv'] }),
        qc.invalidateQueries({ queryKey: ['game-integrations'] }),
      ]);
      if (ok) toast('ok', ok);
      return r;
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível concluir.');
      return null;
    }
  };
}

// ─────────────────────────── Central de Conexões ───────────────────────────

export function ConnectionsPanel({
  canManage,
  onClose,
  onOpenInbox,
  onOpenAds,
  onOpenMarketing,
}: {
  canManage: boolean;
  onClose: () => void;
  onOpenInbox: () => void;
  onOpenAds: () => void;
  onOpenMarketing: () => void;
}) {
  const conns = useConnections();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      title="Central de Conexões"
      subtitle="Contas autorizadas, estado e o que falta configurar"
      icon="🔌"
      onClose={onClose}
      testId="central-panel"
    >
      {conns.isLoading ? <p className="text-xs text-ink-muted">Carregando…</p> : null}
      {GROUPS.map(([g, label]) => {
        const items = (conns.data ?? []).filter((c) => c.group === g);
        if (!items.length) return null;
        return (
          <Section key={g} title={label}>
            <ul className="space-y-1.5">
              {items.map((c) => (
                <ConnectionItem
                  key={c.key}
                  c={c}
                  open={open === c.key}
                  onToggle={() => setOpen(open === c.key ? null : c.key)}
                  canManage={canManage}
                  onOpenInbox={onOpenInbox}
                  onOpenAds={onOpenAds}
                  onOpenMarketing={onOpenMarketing}
                />
              ))}
            </ul>
          </Section>
        );
      })}
      <p className="text-xs text-ink-muted">
        Tokens e chaves ficam guardados cifrados no servidor, nunca no navegador. Envios,
        publicações, mudanças de orçamento, cobranças, notas e pagamentos sempre passam pela sua
        aprovação.
      </p>
    </Panel>
  );
}

const SCOPE_LABEL: Record<string, string> = {
  jogo: 'Planta e agentes',
  operacao: 'Operação da oficina',
  escritorio: 'Escritório e financeiro',
};

/** Cartão "Cenário Gestão": conectar pela tela oficial, estado, permissões e desconectar. */
function CenarioCard({ c }: { c: ConnectionCard }) {
  const f = c.firma;
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!f) return null;
  const start = async () => {
    setBusy('conectar');
    try {
      const r = await api<{ url: string }>('/api/conexoes/cenario/iniciar', { method: 'POST' });
      window.location.href = r.url; // tela oficial do Cenário Gestão (login e autorização lá)
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível iniciar a conexão.');
      setBusy(null);
    }
  };
  const disconnect = async () => {
    if (
      !window.confirm(
        'Desconectar o Cenário Gestão? A planta e as configurações continuam aqui; ações com dados da empresa ficam indisponíveis até reconectar.',
      )
    )
      return;
    setBusy('desconectar');
    try {
      await api('/api/conexoes/cenario/desconectar', { method: 'POST' });
      toast('ok', 'Cenário Gestão desconectado. A planta continua disponível.');
      await qc.invalidateQueries();
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível desconectar.');
    } finally {
      setBusy(null);
    }
  };
  const suspended = f.status === 'EXPIRADA' || f.status === 'REVOGADA';
  return (
    <div className="space-y-2" data-testid="cenario-card">
      {f.status === 'CONECTADA' ? (
        <>
          <KV k="Empresa" v={f.company?.name ?? '—'} />
          {f.company?.document ? <KV k="CNPJ" v={f.company.document} /> : null}
          <KV
            k="Autorizado por"
            v={`${f.cenarioUser?.name ?? ''}${f.cenarioUser?.email ? ` (${f.cenarioUser.email})` : ''}`}
          />
          <KV
            k="Permissões"
            v={`${f.permissions.length} liberadas · ${f.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}`}
          />
          <KV k="Conectado em" v={f.connectedAt ? fmtDateTime(f.connectedAt) : '—'} />
          <KV k="Última sincronização" v={f.lastSyncAt ? fmtDateTime(f.lastSyncAt) : '—'} />
          <p className="text-ink-muted">
            Sua senha do Cenário não fica no Firma Viva: guardamos só a autorização, protegida no
            servidor. Revogue quando quiser aqui ou em Aplicativos conectados, no Cenário.
          </p>
        </>
      ) : suspended ? (
        <div
          className="rounded-lg bg-danger-50 p-2 text-danger-700"
          data-testid="cenario-suspended"
        >
          <div className="font-bold">Conexão suspensa</div>
          {f.status === 'REVOGADA'
            ? 'A autorização foi revogada no Cenário Gestão.'
            : 'A autorização expirou.'}{' '}
          As ações com dados da empresa estão pausadas. A planta e as configurações continuam aqui.
          Clique em “Reconectar Cenário Gestão” e autorize de novo na tela oficial.
        </div>
      ) : (
        <p className="text-ink-soft">
          Conecte o Cenário Gestão para ver OS, funcionários, materiais, estoque e o caixa da sua
          empresa no mapa. Você entra na tela oficial do Cenário, escolhe a empresa, revisa as
          permissões e autoriza. Sua senha é digitada só lá.
        </p>
      )}
      {f.canManage ? (
        <div className="flex flex-wrap gap-1.5">
          {f.status !== 'CONECTADA' ? (
            <GBtn
              tone="primary"
              onClick={() => void start()}
              disabled={busy !== null}
              testId="cenario-connect"
            >
              {busy === 'conectar'
                ? 'Abrindo o Cenário…'
                : suspended || f.status === 'DESCONECTADA'
                  ? 'Reconectar Cenário Gestão'
                  : 'Conectar Cenário Gestão'}
            </GBtn>
          ) : (
            <>
              <GBtn
                onClick={() => void start()}
                disabled={busy !== null}
                testId="cenario-reconnect"
              >
                Reconectar
              </GBtn>
              <GBtn
                tone="danger"
                onClick={() => void disconnect()}
                disabled={busy !== null}
                testId="cenario-disconnect"
              >
                {busy === 'desconectar' ? 'Desconectando…' : 'Desconectar'}
              </GBtn>
            </>
          )}
        </div>
      ) : (
        <p className="text-ink-muted">Só administradores da organização conectam ou desconectam.</p>
      )}
    </div>
  );
}

function stateTone(c: ConnectionCard) {
  if (c.status === 'CONECTADA') return c.mode === 'TESTE_LOCAL' ? 'info' : 'ok';
  if (c.status === 'ERRO' || c.status === 'EXPIRADA' || c.status === 'REVOGADA') return 'risco';
  return 'atencao';
}

function ConnectionItem({
  c,
  open,
  onToggle,
  canManage,
  onOpenInbox,
  onOpenAds,
  onOpenMarketing,
}: {
  c: ConnectionCard;
  open: boolean;
  onToggle: () => void;
  canManage: boolean;
  onOpenInbox: () => void;
  onOpenAds: () => void;
  onOpenMarketing: () => void;
}) {
  const act = useAct();
  const [apiKey, setApiKey] = useState('');
  const [sim, setSim] = useState({
    from: '5512991110000',
    name: 'Hadassa Lima',
    text: 'Oi! Quanto fica a reforma do meu sofá de 3 lugares? Tem 2,10 m de largura.',
  });
  const connected = c.status === 'CONECTADA';
  const test = c.mode === 'TESTE_LOCAL';
  const isChannel = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER'].includes(c.key);
  const connect = async () => {
    const r = await act<{ authorizeUrl?: string }>(
      `/api/v1/connections/${c.key}/connect`,
      apiKey ? { apiKey } : {},
    );
    if (r?.authorizeUrl) window.location.href = r.authorizeUrl; // autorização oficial do provedor
  };
  return (
    <li className="rounded-xl border border-line bg-white text-xs" data-testid={`conn-${c.key}`}>
      <button
        className="flex w-full items-center justify-between gap-2 p-2.5 text-left"
        onClick={onToggle}
      >
        <div className="min-w-0">
          <div className="font-bold">{c.label}</div>
          <div className="truncate text-ink-muted">
            {c.accountLabel ?? c.provider}
            {c.lastSyncAt ? ` · ${fmtDateTime(c.lastSyncAt)}` : ''}
          </div>
        </div>
        <Tone tone={stateTone(c)}>
          {c.status === 'CONECTADA' && test
            ? 'Modo de teste'
            : c.mode === 'IMPORTACAO' && c.status === 'CONECTADA'
              ? 'Por importação'
              : c.realIntegration === 'parcial'
                ? 'Conectada (sem emissão real)'
                : (STATUS_LABEL[c.status] ?? c.status)}
        </Tone>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-line p-2.5">
          {c.key === 'CENARIO' ? <CenarioCard c={c} /> : null}
          <ul className="list-disc pl-4 text-ink-soft">
            {c.capabilities.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          {c.lastError ? (
            <div className="rounded bg-danger-50 p-1.5 text-danger-700">{c.lastError}</div>
          ) : null}
          {c.verified.tested.length || c.verified.pending.length ? (
            <div
              className="rounded-lg border border-line bg-white p-2"
              data-testid={`verified-${c.key}`}
            >
              {c.verified.tested.length ? (
                <>
                  <div className="font-semibold text-ok-600">
                    Testado de ponta a ponta{c.realIntegration === 'sim' ? '' : ' (modo de teste)'}:
                  </div>
                  {c.verified.tested.map((x) => (
                    <div key={x}>
                      <Ic e="✓" /> {x}
                    </div>
                  ))}
                </>
              ) : null}
              {c.verified.pending.length ? (
                <>
                  <div className="mt-1 font-semibold text-warn-600">
                    Depende de configuração/conta real:
                  </div>
                  {c.verified.pending.map((x) => (
                    <div key={x}>• {x}</div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
          {c.missing.length ? (
            <div
              className="rounded-lg border border-warn-600/30 bg-warn-50 p-2"
              data-testid={`missing-${c.key}`}
            >
              <div className="font-semibold">Falta configurar no servidor:</div>
              {c.missing.map((m) => (
                <div key={m.name}>
                  <code>{m.name}</code> — {m.what}
                </div>
              ))}
            </div>
          ) : null}
          {c.external.length ? (
            <div className="rounded-lg border border-line bg-subtle p-2">
              <div className="font-semibold">Fora do sistema:</div>
              {c.external.map((x) => (
                <div key={x}>• {x}</div>
              ))}
            </div>
          ) : null}
          {c.key === 'WHATSAPP' ? (
            <p className="text-ink-muted">
              Coexistência: o número continua no app WhatsApp Business do celular e também chega
              aqui. Confirme a elegibilidade do número antes de migrar; teste primeiro com um número
              de teste.
            </p>
          ) : null}
          {c.pendingAccounts && canManage ? <AccountPicker c={c} /> : null}
          {canManage && c.auth !== 'SESSAO' && c.auth !== 'PLANEJADA' ? (
            <div className="flex flex-wrap gap-1.5">
              {c.auth === 'API_KEY' && !connected ? (
                <input
                  className="w-full rounded border border-line-strong px-2 py-1"
                  placeholder="Chave de API (fica cifrada no servidor)"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              ) : null}
              {c.auth !== 'IMPORTACAO' ? (
                <GBtn
                  tone={connected ? 'default' : 'primary'}
                  onClick={connect}
                  testId={`connect-${c.key}`}
                >
                  {connected ? 'Reconectar' : 'Conectar'}
                </GBtn>
              ) : null}
              {connected ? (
                <GBtn
                  onClick={() => act(`/api/v1/connections/${c.key}/test`, {}, 'Conexão testada.')}
                  testId={`test-${c.key}`}
                >
                  Testar
                </GBtn>
              ) : null}
              {connected ? (
                <GBtn
                  tone="ghost"
                  onClick={() =>
                    act(`/api/v1/connections/${c.key}/disconnect`, {}, 'Desconectada.')
                  }
                >
                  Desconectar
                </GBtn>
              ) : null}
              {c.testModeAvailable && !connected ? (
                <GBtn
                  tone="bronze"
                  onClick={() =>
                    act(`/api/v1/connections/${c.key}/test-mode`, {}, 'Conta de teste conectada.')
                  }
                  testId={`testmode-${c.key}`}
                >
                  Usar conta de teste
                </GBtn>
              ) : null}
            </div>
          ) : null}
          {connected && isChannel ? (
            <GBtn tone="ghost" onClick={onOpenInbox}>
              Abrir caixa de entrada
            </GBtn>
          ) : null}
          {connected && c.key === 'INSTAGRAM' ? (
            <GBtn tone="ghost" onClick={onOpenMarketing}>
              Publicações
            </GBtn>
          ) : null}
          {connected && c.key === 'META_ADS' ? (
            <GBtn tone="ghost" onClick={onOpenAds}>
              Campanhas
            </GBtn>
          ) : null}
          {connected && test && isChannel && canManage ? (
            <div
              className="rounded-lg border border-dashed border-info-600/40 bg-info-50 p-2"
              data-testid={`simulate-${c.key}`}
            >
              <div className="mb-1 font-semibold">
                Simular mensagem de cliente (webhook assinado)
              </div>
              <input
                className="mb-1 w-full rounded border border-line-strong px-2 py-1"
                value={sim.from}
                onChange={(e) => setSim({ ...sim, from: e.target.value })}
                aria-label="Número ou id do contato"
              />
              <input
                className="mb-1 w-full rounded border border-line-strong px-2 py-1"
                value={sim.name}
                onChange={(e) => setSim({ ...sim, name: e.target.value })}
                aria-label="Nome do contato"
              />
              <textarea
                className="mb-1 w-full rounded border border-line-strong px-2 py-1"
                rows={2}
                value={sim.text}
                onChange={(e) => setSim({ ...sim, text: e.target.value })}
                aria-label="Mensagem"
              />
              <div className="flex gap-1.5">
                <GBtn
                  tone="primary"
                  testId={`simulate-send-${c.key}`}
                  onClick={() =>
                    act(
                      `/api/v1/connections/${c.key}/simulate`,
                      sim,
                      'Mensagem chegou na caixa de entrada.',
                    )
                  }
                >
                  Enviar como cliente
                </GBtn>
                {c.key === 'WHATSAPP' ? (
                  <GBtn
                    onClick={() =>
                      act(
                        `/api/v1/connections/${c.key}/simulate`,
                        { ...sim, image: true, imageCaption: 'Foto do sofá' },
                        'Foto recebida.',
                      )
                    }
                  >
                    + foto
                  </GBtn>
                ) : null}
              </div>
            </div>
          ) : null}
          {c.docsUrl ? (
            <a
              className="block text-brand-700 underline"
              href={c.docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Documentação / onde configurar
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function AccountPicker({ c }: { c: ConnectionCard }) {
  const act = useAct();
  const a = c.pendingAccounts!;
  const options =
    c.key === 'WHATSAPP'
      ? a.wabas.flatMap((w) =>
          w.phones.map((p) => ({ id: `${w.id}:${p.id}`, label: `${w.name} · ${p.display}` })),
        )
      : c.key === 'META_ADS'
        ? a.adAccounts.map((x) => ({ id: x.id, label: x.name }))
        : c.key === 'INSTAGRAM'
          ? a.pages
              .filter((p) => p.instagram)
              .map((p) => ({ id: p.id, label: `@${p.instagram!.username} (${p.name})` }))
          : a.pages.map((p) => ({ id: p.id, label: p.name }));
  return (
    <div className="rounded-lg border border-brand-600/30 bg-brand-50 p-2">
      <div className="mb-1 font-semibold">Escolha a conta autorizada</div>
      {options.length ? (
        options.map((o) => (
          <button
            key={o.id}
            className="mb-1 block w-full rounded border border-line bg-white px-2 py-1 text-left"
            onClick={() =>
              act(
                `/api/v1/connections/${c.key}/select-account`,
                { accountId: o.id },
                'Conta conectada.',
              )
            }
          >
            {o.label}
          </button>
        ))
      ) : (
        <div>
          Nenhuma conta compatível foi autorizada. Reconecte e marque a conta certa na Meta.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── Caixa de entrada ───────────────────────────

export function InboxPanel({
  convId,
  onSelect,
  onClose,
  canReply,
}: {
  convId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  canReply: boolean;
}) {
  const inbox = useInbox(true);
  const [filter, setFilter] = useState<string>('');
  const rows = (inbox.data ?? []).filter(
    (r) => !filter || r.channel === filter || r.status === filter,
  );
  if (convId)
    return (
      <ConversationPanel
        id={convId}
        onBack={() => onSelect(null)}
        onClose={onClose}
        canReply={canReply}
      />
    );
  return (
    <Panel
      title="Caixa de entrada"
      subtitle="WhatsApp, Instagram e Messenger"
      icon="📥"
      onClose={onClose}
      testId="inbox-panel"
    >
      <div className="mb-2 flex flex-wrap gap-1">
        {[
          ['', 'Todas'],
          ['WHATSAPP', 'WhatsApp'],
          ['INSTAGRAM', 'Instagram'],
          ['MESSENGER', 'Messenger'],
          ['AGUARDANDO_ORCAMENTO', 'Esperando orçamento'],
        ].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setFilter(k!)}
            className={clsx(
              'rounded-full border px-2 py-0.5 text-xs font-semibold',
              filter === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-white',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {!rows.length ? (
        <p className="text-xs text-ink-muted">
          Nenhuma conversa. Conecte um canal na Central de Conexões (ou use a conta de teste e
          simule uma mensagem).
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              className="w-full rounded-xl border border-line bg-white p-2 text-left text-xs hover:border-brand-600/50"
              onClick={() => onSelect(r.id)}
              data-testid="inbox-row"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-bold">
                  <ChannelBadge channel={r.channel} /> {r.contactName ?? r.contactHandle}
                </span>
                {r.unread ? (
                  <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">
                    {r.unread}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 truncate text-ink-soft">{r.lastText}</div>
              <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-ink-muted">
                <span>{CONV_STATUS[r.status] ?? r.status}</span>
                {r.osNumber ? <span>· OS {String(r.osNumber).padStart(4, '0')}</span> : null}
                {r.customerName ? <span>· {r.customerName}</span> : null}
                {r.humanTakeover ? <span>· assumida por você</span> : null}
                <span>· {fmtDateTime(r.lastMessageAt)}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ConversationPanel({
  id,
  onBack,
  onClose,
  canReply,
}: {
  id: string;
  onBack: () => void;
  onClose: () => void;
  canReply: boolean;
}) {
  const conv = useQuery({
    queryKey: ['inbox-conv', id],
    queryFn: () => api<InboxDetail>(`/api/v1/inbox/${id}`),
  });
  const act = useAct();
  const toast = useToast();
  const draft = conv.data?.messages.find((m) => m.status === 'RASCUNHO');
  const [text, setText] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [tpl, setTpl] = useState('retomar_orcamento');
  const [osQuery, setOsQuery] = useState('');
  // Novo rascunho do agente: carrega no campo para revisão (ajuste durante a renderização).
  if (draft && draft.id !== draftId) {
    setDraftId(draft.id);
    setText(draft.text ?? '');
  }
  useEffect(() => {
    void api(`/api/v1/inbox/${id}/read`, { method: 'POST', body: {} }).catch(() => undefined);
  }, [id, conv.data?.messages.length]);
  const d = conv.data;
  const findOs = async () => {
    const n = Number(osQuery.replace(/\D/g, ''));
    if (!n) return;
    const list = await api<
      { items?: { id: string; number: number }[] } | { id: string; number: number }[]
    >(`/api/v1/service-orders?q=${n}`).catch(() => null);
    const items = Array.isArray(list) ? list : (list?.items ?? []);
    const so = items.find((x) => x.number === n);
    if (!so) {
      toast('danger', `OS ${String(n).padStart(4, '0')} não encontrada.`);
      return;
    }
    await act(
      `/api/v1/inbox/${id}/link`,
      { serviceOrderId: so.id },
      `Conversa vinculada à OS ${String(n).padStart(4, '0')}.`,
    );
  };
  return (
    <Panel
      title={d ? (d.contactName ?? d.contactHandle) : 'Conversa'}
      subtitle={
        d ? (
          <span className="flex items-center gap-1.5">
            <ChannelBadge channel={d.channel} />{' '}
            {d.connection?.accountLabel ?? 'canal desconectado'}
          </span>
        ) : null
      }
      icon="💬"
      onClose={onClose}
      testId="conversation-panel"
      actions={
        <GBtn tone="ghost" onClick={onBack}>
          ← Lista
        </GBtn>
      }
    >
      {!d ? (
        <p className="text-xs">Carregando…</p>
      ) : (
        <>
          {d.summary ? (
            <div
              className="mb-2 rounded-lg border border-bronze-500/30 bg-[#f5ebdf] p-2 text-xs"
              data-testid="conv-summary"
            >
              <b>Resumo do Atendimento:</b> {d.summary}
            </div>
          ) : null}
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
            <Tone tone="info">{CONV_STATUS[d.status] ?? d.status}</Tone>
            {d.serviceOrder ? (
              <a
                className="font-semibold text-brand-700 underline"
                href={cenarioUrl(`/painel/os/${d.serviceOrder.id}`)}
                target="_blank"
                rel="noreferrer"
                data-testid="conv-os"
              >
                OS {String(d.serviceOrder.number).padStart(4, '0')}
              </a>
            ) : null}
            {d.customer ? <span>Cliente: {d.customer.name}</span> : null}
          </div>
          <div
            className="mb-2 max-h-72 space-y-1.5 overflow-y-auto rounded-lg bg-subtle p-2"
            data-testid="conv-messages"
          >
            {d.messages
              .filter((m) => m.status !== 'DESCARTADA' && m.status !== 'RASCUNHO')
              .map((m) => (
                <div
                  key={m.id}
                  className={clsx(
                    'max-w-[85%] rounded-xl px-2.5 py-1.5 text-xs shadow-sm',
                    m.direction === 'IN' ? 'bg-white' : 'ml-auto bg-emerald-100',
                  )}
                >
                  {m.media?.length ? (
                    <div className="mb-1 text-ink-muted">
                      <Ic e="📷" /> {m.media.map((x) => x.caption || x.mime || 'anexo').join(', ')}
                    </div>
                  ) : null}
                  <div className="whitespace-pre-wrap">{m.text}</div>
                  <div className="mt-0.5 text-[10px] text-ink-muted">
                    {fmtDateTime(m.at)} · {MSG_STATUS[m.status] ?? m.status}
                    {m.agent ? ` · por ${m.agent}` : ''}
                    {m.approvedBy
                      ? ` · aprovado por ${m.approvedBy}`
                      : m.createdBy
                        ? ` · ${m.createdBy}`
                        : ''}
                  </div>
                  {m.error ? <div className="text-danger-700">{m.error}</div> : null}
                </div>
              ))}
          </div>
          <div
            className={clsx(
              'mb-2 rounded-lg p-1.5 text-[11px]',
              d.rule.free ? 'bg-ok-50 text-ok-600' : 'bg-warn-50 text-warn-600',
            )}
            data-testid="conv-rule"
          >
            {d.rule.detail}
          </div>
          {canReply ? (
            <>
              {d.rule.free ? (
                <>
                  {draft ? (
                    <div className="mb-1 text-[11px] font-semibold text-bronze-600">
                      Rascunho do {draft.agent ?? 'agente'} — revise antes de enviar
                    </div>
                  ) : null}
                  <textarea
                    className="w-full rounded-lg border border-line-strong p-2 text-xs"
                    rows={4}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    data-testid="conv-text"
                    placeholder="Escreva a resposta…"
                  />
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <GBtn
                      tone="primary"
                      disabled={!text.trim()}
                      testId="conv-send"
                      onClick={async () => {
                        const r = await act(
                          `/api/v1/inbox/${id}/send`,
                          { text, ...(draft && draftId ? { draftId } : {}) },
                          'Mensagem enviada.',
                        );
                        if (r) setText('');
                      }}
                    >
                      Enviar
                    </GBtn>
                    <GBtn
                      onClick={() =>
                        act(`/api/v1/inbox/${id}/draft`, {}, 'Novo rascunho preparado.')
                      }
                      disabled={d.humanTakeover}
                      testId="conv-redraft"
                    >
                      Pedir rascunho ao agente
                    </GBtn>
                  </div>
                </>
              ) : d.rule.needsTemplate ? (
                <div className="flex gap-1.5">
                  <input
                    className="flex-1 rounded border border-line-strong px-2 py-1 text-xs"
                    value={tpl}
                    onChange={(e) => setTpl(e.target.value)}
                    aria-label="Modelo aprovado"
                  />
                  <GBtn
                    tone="primary"
                    onClick={() =>
                      act(
                        `/api/v1/inbox/${id}/send`,
                        { template: { name: tpl, language: 'pt_BR' } },
                        'Modelo enviado.',
                      )
                    }
                  >
                    Enviar modelo
                  </GBtn>
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                <GBtn
                  tone="ghost"
                  onClick={() =>
                    act(
                      `/api/v1/inbox/${id}/takeover`,
                      { on: !d.humanTakeover },
                      d.humanTakeover ? 'Devolvida ao agente.' : 'Você assumiu a conversa.',
                    )
                  }
                  testId="conv-takeover"
                >
                  {d.humanTakeover ? 'Devolver ao agente' : 'Assumir conversa'}
                </GBtn>
                <input
                  className="w-20 rounded border border-line-strong px-2 py-1"
                  placeholder="OS nº"
                  value={osQuery}
                  onChange={(e) => setOsQuery(e.target.value)}
                  data-testid="conv-os-input"
                />
                <GBtn onClick={findOs} testId="conv-link-os">
                  Vincular OS
                </GBtn>
                {d.status !== 'ENCERRADA' ? (
                  <GBtn
                    tone="ghost"
                    onClick={() =>
                      act(
                        `/api/v1/inbox/${id}/link`,
                        { status: 'ENCERRADA' },
                        'Conversa encerrada.',
                      )
                    }
                  >
                    Encerrar
                  </GBtn>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-xs text-ink-muted">
              Responder exige a permissão atendimento.responder.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

// ─────────────────────────── Marketing e Tráfego ───────────────────────────

interface PostRow {
  id: string;
  caption: string;
  mediaUrls: string[];
  status: string;
  scheduledFor: string | null;
  publishedAt: string | null;
  error: string | null;
}
interface Campaign {
  id: string;
  name: string;
  status: string;
  dailyBudgetCents: number | null;
  spendCents7d: number;
  clicks7d: number;
  leads7d: number;
  impressions7d?: number;
}
const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function MarketingPanel({
  onClose,
  canPublish,
}: {
  onClose: () => void;
  canPublish: boolean;
}) {
  const posts = useQuery({
    queryKey: ['mkt-posts'],
    queryFn: () => api<PostRow[]>('/api/v1/marketing/posts'),
  });
  const qc = useQueryClient();
  const act = useAct();
  const [edit, setEdit] = useState<Record<string, { caption: string; media: string }>>({});
  const reload = () => qc.invalidateQueries({ queryKey: ['mkt-posts'] });
  return (
    <Panel
      title="Publicações (Instagram)"
      subtitle="Agente de Marketing prepara; você aprova"
      icon="📸"
      onClose={onClose}
      testId="marketing-panel"
    >
      <GBtn
        tone="primary"
        className="mb-2 w-full"
        testId="mkt-draft"
        onClick={async () => {
          await act('/api/v1/marketing/draft', {}, 'Rascunho preparado com fotos das OS.');
          await reload();
        }}
      >
        Pedir post ao Marketing
      </GBtn>
      {(posts.data ?? []).map((p) => {
        const e = edit[p.id] ?? { caption: p.caption, media: p.mediaUrls.join('\n') };
        return (
          <div
            key={p.id}
            className="mb-2 rounded-xl border border-line bg-white p-2 text-xs"
            data-testid="mkt-post"
          >
            <div className="mb-1 flex justify-between">
              <b>{p.status === 'RASCUNHO' ? 'Prévia' : p.status.replace('_', ' ').toLowerCase()}</b>
              <span className="text-ink-muted">{fmtDateTime(p.publishedAt)}</span>
            </div>
            <div className="mb-1 flex gap-1 overflow-x-auto">
              {p.mediaUrls.map((u) =>
                u.startsWith('/') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={u} src={u} alt="Foto da OS" className="size-16 rounded object-cover" />
                ) : (
                  // Endereço público externo (exigido pela Meta): só o nome, sem carregar aqui.
                  <span
                    key={u}
                    className="flex size-16 items-center justify-center rounded bg-subtle p-1 text-center text-[9px] break-all text-ink-muted"
                  >
                    <Ic e="🖼️" /> {u.split('/').pop()}
                  </span>
                ),
              )}
              {!p.mediaUrls.length ? (
                <span className="text-warn-600">Sem foto: escolha ao menos uma.</span>
              ) : null}
            </div>
            {p.status === 'RASCUNHO' ? (
              <>
                <textarea
                  className="w-full rounded border border-line-strong p-1"
                  rows={4}
                  value={e.caption}
                  onChange={(ev) =>
                    setEdit({ ...edit, [p.id]: { ...e, caption: ev.target.value } })
                  }
                />
                <textarea
                  className="w-full rounded border border-line-strong p-1 font-mono text-[10px]"
                  rows={2}
                  value={e.media}
                  placeholder="Endereços das fotos (um por linha)"
                  onChange={(ev) => setEdit({ ...edit, [p.id]: { ...e, media: ev.target.value } })}
                />
                <div className="mt-1 flex gap-1.5">
                  <GBtn
                    onClick={async () => {
                      try {
                        await api(`/api/v1/marketing/posts/${p.id}`, {
                          method: 'PUT',
                          idempotencyKey: newIdempotencyKey(),
                          body: {
                            caption: e.caption,
                            mediaUrls: e.media
                              .split('\n')
                              .map((x) => x.trim())
                              .filter(Boolean),
                          },
                        });
                        await reload();
                      } catch (er) {
                        void er;
                      }
                    }}
                  >
                    Salvar
                  </GBtn>
                  <GBtn
                    tone="primary"
                    disabled={!canPublish}
                    title={canPublish ? '' : 'Exige marketing.publicar'}
                    testId="mkt-publish"
                    onClick={async () => {
                      await act(`/api/v1/marketing/posts/${p.id}/publish`, {}, 'Publicado.');
                      await reload();
                    }}
                  >
                    Aprovar e publicar
                  </GBtn>
                </div>
              </>
            ) : (
              <div className="whitespace-pre-wrap">{p.caption}</div>
            )}
            {p.error ? <div className="text-danger-700">{p.error}</div> : null}
          </div>
        );
      })}
    </Panel>
  );
}

export function AdsPanel({
  onClose,
  onOpenAgent,
}: {
  onClose: () => void;
  onOpenAgent: () => void;
}) {
  const camp = useQuery({
    queryKey: ['ads'],
    queryFn: () =>
      api<{ account: string; test: boolean; campaigns: Campaign[] }>('/api/v1/ads/campaigns'),
    retry: false,
  });
  const act = useAct();
  const totals = useMemo(
    () =>
      (camp.data?.campaigns ?? []).reduce(
        (a, c) => ({ spend: a.spend + c.spendCents7d, leads: a.leads + c.leads7d }),
        { spend: 0, leads: 0 },
      ),
    [camp.data],
  );
  return (
    <Panel
      title="Campanhas (Meta Ads)"
      subtitle={
        camp.data
          ? `${camp.data.account}${camp.data.test ? ' · dados de teste' : ''}`
          : 'Últimos 7 dias'
      }
      icon="📈"
      onClose={onClose}
      testId="ads-panel"
    >
      {camp.error ? (
        <p className="text-xs text-danger-700">{(camp.error as Error).message}</p>
      ) : null}
      {camp.data ? (
        <>
          <div className="mb-2 grid grid-cols-2 gap-1.5 text-xs">
            <div className="rounded-lg bg-subtle p-2">
              <div className="text-ink-muted">Gasto 7 dias</div>
              <b>{brl(totals.spend)}</b>
            </div>
            <div className="rounded-lg bg-subtle p-2">
              <div className="text-ink-muted">Contatos</div>
              <b>{totals.leads}</b>
            </div>
          </div>
          {camp.data.campaigns.map((c) => (
            <div key={c.id} className="mb-1.5 rounded-xl border border-line bg-white p-2 text-xs">
              <div className="flex justify-between">
                <b>{c.name}</b>
                <Tone tone={c.status === 'ACTIVE' ? 'ok' : 'atencao'}>
                  {c.status === 'ACTIVE' ? 'Ativa' : 'Pausada'}
                </Tone>
              </div>
              <div className="text-ink-soft">
                Orçamento/dia {c.dailyBudgetCents ? brl(c.dailyBudgetCents) : '—'} · gasto{' '}
                {brl(c.spendCents7d)} · {c.clicks7d} cliques · {c.leads7d} contatos
                {c.leads7d ? ` · ${brl(Math.round(c.spendCents7d / c.leads7d))}/contato` : ''}
              </div>
            </div>
          ))}
          <GBtn
            tone="primary"
            className="mt-1 w-full"
            testId="ads-analyze"
            onClick={async () => {
              const r = await act(
                '/api/v1/ads/analyze',
                {},
                'Tráfego analisou e deixou as propostas para você revisar.',
              );
              if (r) onOpenAgent();
            }}
          >
            Pedir análise ao Tráfego
          </GBtn>
          <p className="mt-2 text-xs text-ink-muted">
            Mudanças de orçamento aparecem como propostas com campanha, valor atual → novo e motivo.
            Nada muda na Meta sem a sua aprovação.
          </p>
        </>
      ) : null}
    </Panel>
  );
}

// ─────────────────────────── Histórico do agente ───────────────────────────

interface ActionRow {
  id: string;
  channel: string;
  accountLabel: string | null;
  kind: string;
  summary: string;
  content: string | null;
  status: string;
  approvedBy: string | null;
  createdAt: string;
}
const KIND_LABEL: Record<string, string> = {
  RASCUNHO_RESPOSTA: 'Rascunho de resposta',
  RESPOSTA_APROVADA: 'Resposta aprovada e enviada',
  RESPOSTA_MANUAL: 'Resposta manual',
  ENVIO_AUTOMATICO: 'Envio automático (regra liberada)',
  RASCUNHO_POST: 'Post preparado',
  PUBLICACAO: 'Publicação',
  ANALISE: 'Análise de campanhas',
  ALTERAR_ORCAMENTO: 'Mudança de orçamento',
};
export function AgentActions({ agentId }: { agentId: string }) {
  const q = useQuery({
    queryKey: ['agent-actions', agentId],
    queryFn: () => api<ActionRow[]>(`/api/v1/game/agents/${agentId}/actions`),
  });
  if (!q.data?.length) return null;
  return (
    <Section title="Histórico de ações nos canais">
      <ul className="space-y-1 text-xs" data-testid="agent-actions">
        {q.data.slice(0, 20).map((a) => (
          <li key={a.id} className="rounded-lg border border-line bg-white p-1.5">
            <div className="flex items-center justify-between gap-1">
              <ChannelBadge channel={a.channel} />
              <span className="text-[10px] text-ink-muted">{fmtDateTime(a.createdAt)}</span>
            </div>
            <div className="font-semibold">
              {KIND_LABEL[a.kind] ?? a.kind}: {a.summary}
            </div>
            {a.content ? <div className="line-clamp-2 text-ink-soft">{a.content}</div> : null}
            <div className="text-[10px] text-ink-muted">
              {a.accountLabel ?? 'sem conta'} · {a.status.toLowerCase()}
              {a.approvedBy ? ` · aprovado por ${a.approvedBy}` : ''}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
