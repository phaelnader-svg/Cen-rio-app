'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/misc';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { brDate } from '@/lib/finance';
import { useCan } from '@/lib/hooks';

interface WhatsappEmpresa {
  ready: boolean;
  status: 'DESCONECTADA' | 'PENDENTE' | 'CONECTADA' | 'ERRO' | string;
  test: boolean;
  display: string | null;
  label: string | null;
  since: string | null;
  error: string | null;
  choices: { id: string; display: string; name: string }[];
}

const KEY = ['whatsapp-empresa'] as const;

/**
 * WhatsApp da oficina no Escritório: liga o número que a oficina já usa no WhatsApp Business
 * (continua funcionando no celular). Ligado, o que o dono aprova sai sozinho pelo número da
 * oficina. Só aparece para quem cuida das conexões, e só quando o servidor está pronto.
 */
export function WhatsappCard() {
  const can = useCan();
  const allowed = can('conexoes.gerenciar');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api<WhatsappEmpresa>('/api/v1/whatsapp-empresa'),
    enabled: allowed,
  });
  const [confirmOff, setConfirmOff] = useState(false);
  const m = useMutation({
    mutationFn: async (a: { path: string; body?: unknown }) =>
      api<{ authorizeUrl?: string }>(`/api/v1/whatsapp-empresa/${a.path}`, {
        method: 'POST',
        body: a.body ?? {},
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (r) => {
      if (r?.authorizeUrl) {
        window.location.assign(r.authorizeUrl);
        return;
      }
      setConfirmOff(false);
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['office'] });
    },
  });
  const d = q.data;
  if (!allowed || !d) return null;
  if (!d.ready && d.status !== 'CONECTADA' && d.status !== 'PENDENTE') return null;

  const connect = (
    <Button
      variant="primary"
      icon={<MessageCircle className="size-4" aria-hidden />}
      loading={m.isPending && m.variables?.path === 'conectar'}
      onClick={() => m.mutate({ path: 'conectar' })}
    >
      {d.status === 'ERRO' ? 'Tentar de novo' : 'Conectar WhatsApp'}
    </Button>
  );

  return (
    <section aria-labelledby="whatsapp-titulo" id="whatsapp">
      <h2 id="whatsapp-titulo" className="mb-3 text-lg font-semibold text-ink">
        WhatsApp da oficina
      </h2>
      <Card className="p-4">
        {m.isError && (
          <Alert tone="danger" className="mb-3">
            {errorMessage(m.error)}
          </Alert>
        )}

        {d.status === 'CONECTADA' && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium text-ink">
                Ligado: {d.display ?? d.label}
                {d.test ? ' (teste)' : ''}
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                O que você aprova sai sozinho por este número. No celular, o WhatsApp Business
                continua igual.{d.since ? ` Ligado em ${brDate(d.since)}.` : ''}
              </p>
            </div>
            {confirmOff ? (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setConfirmOff(false)}>
                  Cancelar
                </Button>
                <Button
                  variant="outline-danger"
                  loading={m.isPending}
                  onClick={() => m.mutate({ path: 'desligar' })}
                >
                  Desligar mesmo
                </Button>
              </div>
            ) : (
              <Button variant="outline-danger" onClick={() => setConfirmOff(true)}>
                Desligar
              </Button>
            )}
          </div>
        )}

        {d.status === 'PENDENTE' && d.choices.length > 0 && (
          <div>
            <p className="font-medium text-ink">Qual é o número da oficina?</p>
            <p className="mt-1 mb-3 text-sm text-ink-muted">
              A Meta mostrou mais de um número. Escolha o que os clientes usam.
            </p>
            <ul className="space-y-2">
              {d.choices.map((c) => (
                <li key={c.id}>
                  <Button
                    variant="secondary"
                    className="w-full justify-between"
                    loading={m.isPending && (m.variables?.body as { id?: string })?.id === c.id}
                    onClick={() => m.mutate({ path: 'escolher', body: { id: c.id } })}
                  >
                    <span>{c.display}</span>
                    <span className="text-ink-muted">{c.name}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(d.status === 'DESCONECTADA' ||
          d.status === 'ERRO' ||
          (d.status === 'PENDENTE' && d.choices.length === 0)) && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              {d.status === 'ERRO' && d.error && (
                <Alert tone="danger" className="mb-3">
                  Não ligou: {d.error}
                </Alert>
              )}
              <p className="text-sm text-ink">
                Ligue o mesmo número que a oficina já usa no WhatsApp Business. Ele continua
                funcionando no celular, com as conversas de sempre. Depois disso, o que você aprova
                aqui sai sozinho, sem precisar apertar enviar.
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                Na tela da Meta, escolha conectar o WhatsApp Business que você já usa e escaneie o
                código com o celular da oficina.
              </p>
            </div>
            {connect}
          </div>
        )}
      </Card>
    </section>
  );
}
