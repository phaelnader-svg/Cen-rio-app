'use client';

import type { EmployeeSummaryDto } from '@cenario/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { RealtimeProvider } from '@/lib/realtime';
import { isIOS, isStandalone } from '@/lib/app-install';
import { TabletHome } from './home';
import { IosInstallFromQr } from './install';
import { TabletLogin } from './login';
import { PairingScreen } from './pairing';

type Status =
  | { paired: false }
  | {
      paired: true;
      device: { id: string; name: string };
      company?: { tradeName: string | null };
      employees: EmployeeSummaryDto[];
      authenticated: boolean;
    };

const ENDED: Record<string, string> = {
  revoked: 'Sua sessão foi encerrada pelo gestor. Entre novamente com seu PIN.',
  expired: 'Sua sessão expirou. Entre novamente com seu PIN.',
};

/** Código que veio do código QR (`/tablet?codigo=ABCD2345`). */
function readQrCode() {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('codigo') ?? '';
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 8 ? code : null;
}

function clearQrCode() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('codigo')) return;
  url.searchParams.delete('codigo');
  window.history.replaceState(null, '', url.pathname + url.search);
}

export function TabletApp() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [qrCode] = useState(readQrCode);
  const [useBrowser, setUseBrowser] = useState(false);
  const status = useQuery({
    queryKey: ['tablet-status'],
    queryFn: () => api<Status>('/api/tablet/status'),
    refetchInterval: 60_000,
  });
  const authenticated = status.data?.paired === true && status.data.authenticated;
  const me = useMe(authenticated);
  const meData = authenticated && me.data?.session.kind === 'DEVICE' ? me.data : null;

  // App instalado (2026-11-25): instalar pelo código QR. No iPhone o app instalado não enxerga o
  // que o Safari fez, então o código vai junto no ícone (manifesto com o código) e só é usado
  // quando o app abrir pelo ícone.
  useEffect(() => {
    if (!qrCode) return;
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]'))
      link.setAttribute('href', `/tablet/manifest?codigo=${qrCode}`);
  }, [qrCode]);

  useEffect(() => {
    if (qrCode && status.data?.paired) clearQrCode();
  }, [qrCode, status.data?.paired]);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      void navigator.serviceWorker.register('/sw.js', { scope: '/tablet' }).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      void qc.invalidateQueries({ queryKey: ['tablet-status'] });
    }
  }, [me.error, qc]);

  if (status.isPending) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  if (status.isError) {
    return (
      <div className="mx-auto max-w-lg p-10">
        <Alert tone="danger" title="Sem comunicação com o servidor">
          {status.error.message}
        </Alert>
        <Button size="xl" className="mt-6 w-full" onClick={() => void status.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const data = status.data;
  if (!data.paired) {
    if (qrCode && isIOS() && !isStandalone() && !useBrowser)
      return <IosInstallFromQr onUseBrowser={() => setUseBrowser(true)} />;
    return <PairingScreen notice={notice} initialCode={qrCode} onPaired={clearQrCode} />;
  }
  if (!authenticated) {
    return (
      <TabletLogin
        deviceName={data.device.name}
        companyName={data.company?.tradeName ?? null}
        employees={data.employees}
        notice={notice}
      />
    );
  }
  if (!meData) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }

  return (
    <RealtimeProvider
      key={meData.session.id}
      onSessionEnded={(reason) => {
        setNotice(ENDED[reason] ?? ENDED.revoked!);
        qc.removeQueries({ queryKey: ['me'] });
        void qc.invalidateQueries({ queryKey: ['tablet-status'] });
      }}
    >
      <TabletHome me={meData} />
    </RealtimeProvider>
  );
}
