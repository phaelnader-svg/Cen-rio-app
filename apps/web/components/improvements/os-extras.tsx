'use client';

import { whatsappLink, type OsAlbumDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { Copy, MessageCircle, QrCode } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useState } from 'react';
import { AlbumSections } from '@/components/public/client-pages';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

/** SVG do QR (sem dependência de rede). */
export function qrSvg(text: string, cellSize = 4): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}

/** Endereço gravado na etiqueta: abre a O.S. no painel e o tablet reconhece a peça. */
export const osQrUrl = (origin: string, serviceOrderId: string) =>
  `${origin}/painel/os/${serviceOrderId}`;

/** Lê o id da O.S. de um QR das etiquetas (ou nulo se não for uma etiqueta do sistema). */
export function osIdFromQr(text: string): string | null {
  const m = /\/os\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** Melhoria 82: álbum antes / durante / depois, com link para o cliente. */
export function OsAlbumPanel({
  serviceOrderId,
  customerPhone,
}: {
  serviceOrderId: string;
  customerPhone?: string | null;
}) {
  const toast = useToast();
  const album = useQuery({
    queryKey: ['os-album', serviceOrderId],
    queryFn: () =>
      api<OsAlbumDto & { shareUrl: string }>(`/api/v1/service-orders/${serviceOrderId}/album`),
  });
  if (album.isPending) return <Spinner />;
  if (album.isError) return <Alert tone="danger">{album.error.message}</Alert>;
  const a = album.data;
  const total = a.before.length + a.during.length + a.after.length;
  const text = `Olá, ${a.customerName.split(' ')[0]}! Seguem as fotos do seu serviço (${a.code}): ${a.shareUrl}`;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Álbum de fotos</h2>
          <p className="text-sm text-ink-muted">
            Fotos da retirada, da produção e da entrega, separadas em antes, durante e pronto. Fotos
            de ocorrências não entram.
          </p>
        </div>
        {total > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy className="size-4" aria-hidden />}
              onClick={async () => {
                await navigator.clipboard.writeText(a.shareUrl);
                toast('ok', 'Link do álbum copiado.');
              }}
            >
              Copiar link do álbum
            </Button>
            <a
              href={whatsappLink(customerPhone ?? '', text)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ok-600 px-3 text-sm font-semibold text-white hover:brightness-110"
            >
              <MessageCircle className="size-4" aria-hidden /> Mandar no WhatsApp
            </a>
          </div>
        )}
      </div>
      <AlbumSections album={a} />
    </Card>
  );
}

/** Melhoria 107: etiqueta com QR para colar na peça (uma por peça). */
export function QrLabelButton({
  serviceOrderId,
  code,
  customerName,
  pieces,
}: {
  serviceOrderId: string;
  code: string;
  customerName: string;
  pieces: { code: string; description: string }[];
}) {
  const [open, setOpen] = useState(false);
  const url = typeof window === 'undefined' ? '' : osQrUrl(window.location.origin, serviceOrderId);
  const labels = pieces.length ? pieces : [{ code, description: '' }];
  const svg = url ? qrSvg(url) : '';
  return (
    <>
      <Button
        variant="secondary"
        icon={<QrCode className="size-4" aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Etiqueta QR
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Etiquetas QR das peças"
        description="Imprima e cole na peça. No tablet, o botão Ler etiqueta abre a tarefa da peça; no celular, a câmera abre esta O.S."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Fechar
            </Button>
            <Button
              icon={<QrCode className="size-4" aria-hidden />}
              onClick={() => {
                const win = window.open('', '_blank', 'width=720,height=900');
                if (!win) return;
                win.document.write(labelsHtml(labels, svg, code, customerName));
                win.document.close();
                win.focus();
                setTimeout(() => win.print(), 300);
              }}
            >
              Imprimir etiquetas
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {labels.map((p) => (
            <div key={p.code} className="flex items-center gap-3 rounded-xl border border-line p-3">
              <div
                className="size-24 shrink-0 bg-white"
                // SVG gerado localmente pelo qrcode-generator (sem conteúdo do usuário).
                dangerouslySetInnerHTML={{ __html: svg }}
              />
              <div className="min-w-0 text-sm">
                <p className="font-semibold">{p.code}</p>
                <p className="truncate">{customerName}</p>
                {p.description && <p className="truncate text-ink-muted">{p.description}</p>}
              </div>
            </div>
          ))}
        </div>
      </Dialog>
    </>
  );
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function labelsHtml(
  labels: { code: string; description: string }[],
  svg: string,
  code: string,
  customer: string,
) {
  const cards = labels
    .map(
      (p) =>
        `<div class="l"><div class="q">${svg}</div><div><b>${esc(p.code)}</b><br>${esc(
          customer,
        )}<br><span>${esc(p.description || code)}</span></div></div>`,
    )
    .join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Etiquetas ${esc(code)}</title><style>
  @page{margin:8mm}body{font:12px system-ui,sans-serif;margin:0}
  .g{display:grid;grid-template-columns:1fr 1fr;gap:4mm}
  .l{display:flex;gap:3mm;align-items:center;border:1px dashed #999;padding:3mm;break-inside:avoid;height:30mm}
  .q{width:26mm;height:26mm;flex:none}.q svg{width:100%;height:100%}
  b{font-size:14px}span{color:#555}
  </style></head><body><div class="g">${cards}</div></body></html>`;
}
