'use client';

import type { CompanyPaymentProofDto } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, Send } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { MoneyField } from '@/components/ui/form';
import { Alert, Badge } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatCents, formatDay } from '@/lib/billing';

/** Item 40: QR Code do PIX já com o valor (gerado no aparelho, a partir do "copia e cola"). */
export function PixQr({ code, size = 'size-48' }: { code: string; size?: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [code]);
  return (
    <div
      data-testid="pix-qr"
      className={`${size} shrink-0 rounded-xl border border-line bg-white p-1`}
      // SVG gerado localmente pelo qrcode-generator (só o código do PIX).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const todayYmd = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

/** Foto do comprovante reduzida no aparelho (JPEG até 1600 px), para mandar rápido. */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error('Não deu para abrir a foto.'));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82).split(',')[1]!;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

const PROOF_LABEL = {
  PENDENTE: { text: 'Conferindo', tone: 'warn' },
  CONFIRMADO: { text: 'Confirmado', tone: 'ok' },
  RECUSADO: { text: 'Não conferiu', tone: 'danger' },
} as const;

/**
 * Item 41: o cliente manda a foto (ou o PDF) do comprovante aqui mesmo; o dono da plataforma
 * confere e libera com 1 clique. Sem WhatsApp no meio.
 */
export function ProofSender({
  amountCents,
  proofs,
}: {
  amountCents: number;
  proofs: CompanyPaymentProofDto[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [cents, setCents] = useState<number | null>(amountCents);
  const [paidOn, setPaidOn] = useState(todayYmd());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const pending = proofs.find((p) => p.status === 'PENDENTE');

  async function send() {
    if (!file) {
      setError('Escolha a foto ou o PDF do comprovante.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const isPdf = file.type === 'application/pdf';
      if (isPdf && file.size > 1_400_000)
        throw new Error('O PDF é grande demais. Mande um print ou uma foto do comprovante.');
      const data = isPdf ? await readBase64(file) : await shrinkImage(file);
      await api('/api/v1/subscription/proofs', {
        method: 'POST',
        body: {
          amountCents: cents ?? 0,
          paidOn,
          mime: isPdf ? 'application/pdf' : 'image/jpeg',
          data,
        },
      });
      setFile(null);
      if (input.current) input.current.value = '';
      await qc.invalidateQueries({ queryKey: ['subscription'] });
      toast('ok', 'Comprovante enviado. Assim que for conferido, você recebe um e-mail.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="comprovante">
      <p className="font-semibold text-ink">Já pagou? Mande o comprovante</p>
      {pending ? (
        <Alert tone="info">
          Recebemos o comprovante de {formatCents(pending.amountCents)} (
          {formatDay(pending.paidOn + 'T12:00:00Z')}). Assim que for conferido, o sistema libera e
          você recebe um e-mail.
        </Alert>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <MoneyField label="Valor pago" cents={cents} onCents={setCents} cols={12} />
            <Field label="Dia do pagamento">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={paidOn}
                  max={todayYmd()}
                  onChange={(e) => setPaidOn(e.target.value)}
                />
              )}
            </Field>
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*,application/pdf"
            className="sr-only"
            id="comprovante-arquivo"
            data-testid="comprovante-arquivo"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="comprovante-arquivo"
              className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 font-semibold text-ink hover:bg-subtle"
            >
              <Paperclip className="size-4" aria-hidden />
              {file ? 'Trocar o arquivo' : 'Escolher a foto ou o PDF'}
            </label>
            {file && <span className="min-w-0 truncate text-sm text-ink-muted">{file.name}</span>}
          </div>
          <Button
            className="w-full"
            onClick={send}
            loading={sending}
            disabled={!file}
            icon={<Send className="size-4" aria-hidden />}
            data-testid="comprovante-enviar"
          >
            Mandar o comprovante
          </Button>
          {error && <Alert tone="danger">{error}</Alert>}
        </>
      )}
      {proofs.filter((p) => p !== pending).slice(0, 3).length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line text-sm">
          {proofs
            .filter((p) => p !== pending)
            .slice(0, 3)
            .map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="text-ink-muted">{formatDay(p.paidOn + 'T12:00:00Z')}</span>
                <span className="font-medium">{formatCents(p.amountCents)}</span>
                <Badge tone={PROOF_LABEL[p.status].tone}>{PROOF_LABEL[p.status].text}</Badge>
                {p.rejectReason && (
                  <span className="w-full text-ink-soft">Motivo: {p.rejectReason}</span>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
