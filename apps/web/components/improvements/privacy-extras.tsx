'use client';

import {
  PRIVACY_REQUEST_KINDS,
  PRIVACY_REQUEST_KIND_LABEL,
  PRIVACY_REQUEST_STATUS_LABEL,
  PRIVACY_REQUESTER_KIND_LABEL,
  PRIVACY_RESPONSE_DAYS,
  type PrivacyRequestDto,
  type PrivacyRequestKind,
  type PrivacyRequestStatus,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormGrid, SelectField, TextAreaField } from '@/components/ui/form';
import { Alert, Badge, Card, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

/**
 * LGPD (2026-11-25): pedir sobre os próprios dados (Minha conta) ou sobre a empresa inteira
 * (tela Empresa, só o gestor). O pedido vai para o encarregado de dados; nada é apagado sozinho.
 */
export function PrivacyRequestCard({ scope }: { scope: 'MINHA_CONTA' | 'EMPRESA' }) {
  const empresa = scope === 'EMPRESA';
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PrivacyRequestKind>('EXCLUIR');
  const [message, setMessage] = useState('');
  const send = useMutation({
    mutationFn: () =>
      api<{ protocol: string; dueAt: string }>('/api/v1/privacy/my-request', {
        method: 'POST',
        body: { scope, kind, message: message.trim() || undefined },
      }),
  });
  const close = () => {
    setOpen(false);
    send.reset();
    setMessage('');
    setKind('EXCLUIR');
  };
  return (
    <Card className="mt-6 max-w-lg p-6" data-testid={`privacidade-${scope}`}>
      <h2 className="flex items-center gap-2 font-semibold">
        <ShieldCheck className="size-4" aria-hidden />
        {empresa ? 'Apagar a conta da empresa' : 'Seus dados'}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        {empresa
          ? 'Para encerrar a conta e apagar os dados da empresa, faça o pedido aqui. Antes, baixe todos os dados acima: depois de apagados, não dá para recuperar.'
          : 'Peça para ver, corrigir, receber uma cópia ou apagar os seus dados pessoais.'}{' '}
        A resposta chega no seu e-mail em até {PRIVACY_RESPONSE_DAYS} dias.{' '}
        <a href="/privacidade" target="_blank" className="font-medium text-brand-700 underline">
          Política de privacidade
        </a>
      </p>
      <Button
        variant={empresa ? 'outline-danger' : 'secondary'}
        className="mt-4"
        onClick={() => setOpen(true)}
      >
        {empresa ? 'Pedir para apagar a empresa' : 'Fazer um pedido sobre os meus dados'}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={empresa ? 'Apagar a conta da empresa' : 'Pedido sobre os seus dados'}
        description={
          empresa
            ? 'O pedido vai para o encarregado de dados. Ninguém apaga nada sem confirmar com você antes.'
            : 'O pedido vai para o encarregado de dados, já com a sua conta identificada.'
        }
      >
        {send.data ? (
          <Alert tone="ok" title={`Pedido enviado. Protocolo ${send.data.protocol}`}>
            Você recebe a resposta por e-mail até {day(send.data.dueAt)}. Nada foi apagado ainda.
          </Alert>
        ) : (
          <>
            <FormGrid>
              <SelectField
                label="O que você quer"
                cols={12}
                value={kind}
                onChange={(e) => setKind(e.target.value as PrivacyRequestKind)}
              >
                {(empresa
                  ? (['EXCLUIR', 'PORTABILIDADE', 'OUTRO'] as const)
                  : PRIVACY_REQUEST_KINDS
                ).map((k) => (
                  <option key={k} value={k}>
                    {empresa && k === 'EXCLUIR'
                      ? 'Encerrar a conta e apagar os dados da empresa'
                      : PRIVACY_REQUEST_KIND_LABEL[k]}
                  </option>
                ))}
              </SelectField>
              <TextAreaField
                label="Quer explicar melhor? (opcional)"
                cols={12}
                rows={3}
                maxLength={2000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </FormGrid>
            {kind === 'EXCLUIR' && (
              <Alert tone="warn" className="mt-4">
                {empresa
                  ? 'Apagar a empresa apaga clientes, serviços, ordens de serviço, financeiro e o acesso de toda a equipe. Os dados de cobrança e os registros de acesso ficam guardados pelo prazo da lei.'
                  : 'Apagar os seus dados encerra o seu acesso. O que você fez no sistema continua no histórico da empresa, sem o seu nome quando a lei permitir.'}
              </Alert>
            )}
            {send.error && (
              <Alert tone="danger" className="mt-3">
                {errorMessage(send.error)}
              </Alert>
            )}
          </>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {send.data ? 'Fechar' : 'Voltar'}
          </Button>
          {!send.data && (
            <Button loading={send.isPending} onClick={() => send.mutate()}>
              Enviar pedido
            </Button>
          )}
        </div>
      </Dialog>
    </Card>
  );
}

const STATUS_TONE: Record<PrivacyRequestStatus, 'warn' | 'info' | 'ok' | 'neutral'> = {
  NOVO: 'warn',
  EM_ANDAMENTO: 'info',
  ATENDIDO: 'ok',
  RECUSADO: 'neutral',
};

/** Dono da plataforma (tela Empresas): todos os pedidos sobre dados, com o prazo da lei. */
export function PrivacyRequestsInbox() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['platform-privacy'],
    queryFn: () => api<{ items: PrivacyRequestDto[] }>('/api/v1/platform/privacy-requests'),
  });
  const mark = useMutation({
    mutationFn: ({ id, status }: { id: string; status: PrivacyRequestStatus }) =>
      api(`/api/v1/platform/privacy-requests/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-privacy'] }),
  });
  const items = q.data?.items ?? [];
  const open = items.filter((i) => i.status === 'NOVO' || i.status === 'EM_ANDAMENTO');
  const late = open.filter((i) => new Date(i.dueAt) < new Date()).length;
  return (
    <Card className="mb-6 p-5" data-testid="pedidos-lgpd">
      <h2 className="font-semibold">
        Pedidos sobre dados pessoais (LGPD){' '}
        {open.length > 0 && (
          <Badge tone="warn" className="ml-1 align-middle">
            {open.length} em aberto
          </Badge>
        )}
        {late > 0 && (
          <Badge tone="danger" className="ml-1 align-middle">
            {late} passou do prazo
          </Badge>
        )}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Prazo da lei: {PRIVACY_RESPONSE_DAYS} dias. Nada é apagado sozinho: confira quem pediu,
        responda pelo e-mail da pessoa e marque aqui.
      </p>
      {q.isPending ? (
        <Spinner className="mt-3" />
      ) : q.isError ? (
        <Alert tone="danger" className="mt-3">
          {errorMessage(q.error)}
        </Alert>
      ) : !items.length ? (
        <p className="mt-2 text-sm text-ink-muted">Nenhum pedido ainda.</p>
      ) : (
        <ul className="mt-3 max-h-[28rem] divide-y divide-line overflow-y-auto rounded-xl border border-line">
          {items.map((r) => {
            const overdue =
              (r.status === 'NOVO' || r.status === 'EM_ANDAMENTO') &&
              new Date(r.dueAt) < new Date();
            return (
              <li key={r.id} className="flex flex-wrap items-start gap-3 px-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.scope === 'EMPRESA' && r.kind === 'EXCLUIR'
                      ? 'Apagar a conta da empresa'
                      : PRIVACY_REQUEST_KIND_LABEL[r.kind]}{' '}
                    <Badge tone={STATUS_TONE[r.status]} className="ml-1">
                      {PRIVACY_REQUEST_STATUS_LABEL[r.status]}
                    </Badge>{' '}
                    <span className="text-ink-muted">· protocolo {r.protocol}</span>
                  </p>
                  <p className="mt-1">
                    {r.name} ({r.email})
                    {r.scope === 'EMPRESA'
                      ? ` · empresa inteira: ${r.companyName}`
                      : r.scope === 'MINHA_CONTA'
                        ? ` · conta na empresa ${r.companyName}`
                        : r.requester
                          ? ` · ${PRIVACY_REQUESTER_KIND_LABEL[r.requester]}`
                          : ''}
                    {r.company && r.scope === 'PUBLICO' ? ` · tapeçaria: ${r.company}` : ''}
                  </p>
                  {r.message && <p className="mt-1 whitespace-pre-line">{r.message}</p>}
                  <p
                    className={
                      overdue ? 'mt-1 text-xs text-danger-600' : 'mt-1 text-xs text-ink-muted'
                    }
                  >
                    Pedido em {day(r.createdAt)} · responder até {day(r.dueAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {r.status === 'NOVO' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={mark.isPending && mark.variables?.id === r.id}
                      onClick={() => mark.mutate({ id: r.id, status: 'EM_ANDAMENTO' })}
                    >
                      Em andamento
                    </Button>
                  )}
                  {(r.status === 'NOVO' || r.status === 'EM_ANDAMENTO') && (
                    <Button
                      size="sm"
                      loading={mark.isPending && mark.variables?.id === r.id}
                      onClick={() => mark.mutate({ id: r.id, status: 'ATENDIDO' })}
                    >
                      Atendido
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
