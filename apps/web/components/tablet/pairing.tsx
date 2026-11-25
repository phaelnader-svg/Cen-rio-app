'use client';

import { normalizePairingCode, pairDeviceSchema } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { InstallBanner } from './install';

export function PairingScreen({
  notice,
  initialCode,
  onPaired,
}: {
  notice?: string | null;
  /** App instalado (2026-11-25): código que veio do código QR — vincula sozinho, sem digitar. */
  initialCode?: string | null;
  onPaired?: () => void;
}) {
  const qc = useQueryClient();
  const [code, setCode] = useState(initialCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api('/api/tablet/pair', { method: 'POST', body: { code } }),
    onSuccess: async () => {
      onPaired?.();
      qc.removeQueries({ queryKey: ['me'] });
      await qc.refetchQueries({ queryKey: ['tablet-status'] });
    },
    onError: (e) =>
      setError(
        initialCode
          ? 'Este código QR já foi usado ou passou da hora. Peça ao gestor um novo em Dispositivos.'
          : errorMessage(e),
      ),
  });
  const auto = useRef(false);
  useEffect(() => {
    if (!initialCode || auto.current) return;
    auto.current = true;
    m.mutate();
  }, [initialCode, m]);

  const normalized = normalizePairingCode(code);
  const display =
    normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}` : normalized;

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-10">
      <div className="w-full max-w-lg text-center">
        <BrandMark className="mx-auto mb-12 w-fit" />
        <span className="mx-auto mb-5 grid size-16 place-items-center rounded-2xl bg-brand-50 text-brand-700">
          <Link2 className="size-8" aria-hidden />
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">Ligar este aparelho à empresa</h1>
        <p className="mt-2 text-lg text-ink-muted">
          Aponte a câmera para o código QR que o gestor mostra em Dispositivos, ou digite o código
          aqui.
        </p>
        {notice && (
          <Alert tone="warn" className="mt-6 text-left">
            {notice}
          </Alert>
        )}
        <form
          className="mt-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pairDeviceSchema.safeParse({ code }).success) {
              setError('O código tem 8 caracteres (ex.: ABCD-2345).');
              return;
            }
            setError(null);
            m.mutate();
          }}
        >
          <label htmlFor="pairing-code" className="sr-only">
            Código de vinculação
          </label>
          <input
            id="pairing-code"
            value={display}
            onChange={(e) => setCode(normalizePairingCode(e.target.value).slice(0, 8))}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            className="input h-20 text-center font-mono text-4xl font-semibold tracking-[0.2em] uppercase"
            aria-invalid={error ? true : undefined}
            autoFocus
          />
          {error && (
            <p role="alert" className="mt-3 text-base text-danger-600">
              {error}
            </p>
          )}
          <Button type="submit" size="xl" className="mt-6 w-full" loading={m.isPending}>
            Ligar aparelho
          </Button>
        </form>
        {/* O app da equipe se instala por aqui (tablet e celular); o do dono, pelo site. */}
        <div className="mt-8 flex w-full justify-center">
          <InstallBanner />
        </div>
      </div>
    </main>
  );
}
