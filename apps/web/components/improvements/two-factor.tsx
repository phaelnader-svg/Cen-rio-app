'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { qrSvg } from '@/components/improvements/os-extras';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Badge, Card } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';

/** Melhoria 98: verificação em duas etapas (opcional), com aplicativo autenticador. */
export function TwoFactorCard() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const enabled = me.data?.user.twoFactor ?? false;
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);

  const start = useMutation({
    mutationFn: () =>
      api<{ secret: string; otpauthUrl: string }>('/api/v1/account/2fa/setup', {
        method: 'POST',
        body: {},
      }),
    onSuccess: (r) => {
      setSetup(r);
      setCode('');
    },
  });
  const enable = useMutation({
    mutationFn: () =>
      api<{ recoveryCodes: string[] }>('/api/v1/account/2fa/enable', {
        method: 'POST',
        body: { code: code.trim() },
      }),
    onSuccess: async (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const disable = useMutation({
    mutationFn: () =>
      api('/api/v1/account/2fa/disable', {
        method: 'POST',
        body: { code: code.trim().toUpperCase() },
      }),
    onSuccess: async () => {
      toast('ok', 'Verificação em duas etapas desligada.');
      setDisabling(false);
      setCode('');
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const err = start.error ?? enable.error ?? disable.error;

  return (
    <Card className="mt-6 max-w-lg p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Verificação em duas etapas</h2>
        <Badge tone={enabled ? 'ok' : 'neutral'}>{enabled ? 'Ligada' : 'Desligada'}</Badge>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        Além da senha, o painel pede um código de 6 números do aplicativo autenticador do seu
        celular. Protege a conta mesmo se alguém descobrir a senha.
      </p>
      {err && (
        <Alert tone="danger" className="mt-4">
          {errorMessage(err)}
        </Alert>
      )}

      {codes && (
        <Alert tone="ok" className="mt-4" title="Ligada. Guarde os códigos de recuperação">
          <p>
            Cada código entra uma vez, se você ficar sem o celular. Anote ou imprima e guarde em
            lugar seguro; eles não aparecem de novo.
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-ink">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Alert>
      )}

      {!enabled && !setup && (
        <Button
          className="mt-4"
          icon={<ShieldCheck className="size-4" aria-hidden />}
          loading={start.isPending}
          onClick={() => start.mutate()}
        >
          Ligar verificação em duas etapas
        </Button>
      )}

      {setup && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            <li>
              Instale um aplicativo autenticador (Google Authenticator ou Microsoft Authenticator).
            </li>
            <li>No aplicativo, escolha adicionar conta e leia o QR abaixo.</li>
            <li>Digite o código de 6 números que aparecer.</li>
          </ol>
          <div
            className="mx-auto size-44 rounded-xl bg-white p-2"
            // SVG gerado localmente; o QR leva o segredo, que não sai deste aparelho.
            dangerouslySetInnerHTML={{ __html: qrSvg(setup.otpauthUrl) }}
          />
          <p className="text-center text-xs text-ink-muted">
            Sem câmera? Digite no aplicativo a chave{' '}
            <span className="font-mono break-all text-ink">{setup.secret}</span>
          </p>
          <Field label="Código de 6 números">
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" loading={enable.isPending} disabled={code.trim().length !== 6}>
              Confirmar e ligar
            </Button>
            <Button type="button" variant="secondary" onClick={() => setSetup(null)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      {enabled &&
        (disabling ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
          >
            <Field label="Código do aplicativo (ou de recuperação)">
              {(p) => (
                <Input
                  {...p}
                  autoComplete="one-time-code"
                  maxLength={9}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={disable.isPending}>
                Desligar
              </Button>
              <Button type="button" variant="secondary" onClick={() => setDisabling(false)}>
                Cancelar
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" className="mt-4" onClick={() => setDisabling(true)}>
            Desligar
          </Button>
        ))}
    </Card>
  );
}
