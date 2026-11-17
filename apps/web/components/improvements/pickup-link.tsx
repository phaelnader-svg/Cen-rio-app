'use client';

import { whatsappLink } from '@cenario/shared';
import { CalendarCheck, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

/** Melhoria 130: link para o cliente escolher o dia e o turno da retirada. */
export function PickupScheduleLink({
  pickupId,
  code,
  customerName,
  phone,
}: {
  pickupId: string;
  code: string;
  customerName: string;
  phone: string | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const getUrl = async () => {
    setBusy(true);
    try {
      return (await api<{ url: string }>(`/api/v1/pickups/${pickupId}/schedule-link`)).url;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-sm font-medium">Deixar o cliente escolher o dia</p>
      <p className="text-xs text-ink-muted">
        O cliente abre o link, escolhe o dia e o turno, e a retirada fica agendada sozinha.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          icon={<Copy className="size-3.5" aria-hidden />}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(await getUrl());
              toast('ok', 'Link copiado.');
            } catch (e) {
              toast('danger', errorMessage(e));
            }
          }}
        >
          Copiar link
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<CalendarCheck className="size-3.5" aria-hidden />}
          onClick={async () => {
            const win = window.open('', '_blank');
            try {
              const url = await getUrl();
              const text = `Olá, ${customerName.split(' ')[0]}! Para a retirada ${code}, escolha o melhor dia e turno por aqui: ${url}`;
              if (win) win.location.href = whatsappLink(phone, text);
            } catch (e) {
              win?.close();
              toast('danger', errorMessage(e));
            }
          }}
        >
          Mandar no WhatsApp
        </Button>
      </div>
    </div>
  );
}
