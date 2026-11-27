'use client';

import {
  PICKUP_SHIFT_LABEL,
  formatCents,
  whatsappLink,
  type OsAlbumDto,
  type OsAlbumPhoto,
  type PublicPickupDto,
  type PublicQuoteDto,
  type PublicReviewDto,
  type PublicStatusDto,
  type QuoteSnapshot,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, MessageCircle, Star } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { LogoMark } from '@/components/brand';
import { ProposalDocument } from '@/components/quotes/documents';
import { Button } from '@/components/ui/button';
import { buttonClass } from '@/components/ui/button-styles';
import { Textarea } from '@/components/ui/field';
import { Alert, Card, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

const brDay = (d: string) => d.slice(0, 10).split('-').reverse().join('/');
const weekday = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long' });

function CompanyHeader({ name, logo }: { name: string; logo?: string | null }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" className="size-12 rounded-xl object-contain" />
      ) : null}
      <p className="text-lg font-semibold">{name}</p>
    </div>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">{what} não encontrado</h1>
      <p className="mt-1 text-sm text-ink-muted">
        O link pode estar incompleto. Peça um novo link para a tapeçaria.
      </p>
    </Card>
  );
}

function Footer() {
  return (
    <p className="mt-10 flex items-center justify-center gap-2 text-xs text-ink-muted">
      <LogoMark className="size-4" /> Enviado pelo Cenário Gestão
    </p>
  );
}

// ─────────────────────────── Proposta (79) ───────────────────────────

/**
 * A proposta do link no mesmo visual de "Visualizar proposta" do painel. O link só traz o que está
 * na proposta impressa; custos, lucro e taxas internas ficam zerados aqui e não aparecem.
 */
function proposalSnapshot(p: PublicQuoteDto): QuoteSnapshot {
  return {
    companyName: p.companyName,
    logoDataUrl: p.logoDataUrl,
    texts: p.texts ?? undefined,
    issuedAt: p.issuedAt,
    customerName: p.customerName,
    phone: p.customerPhone,
    city: p.city,
    service: p.service,
    foamChange: p.foamChange,
    fabricChange: p.fabricChange,
    fabrics: p.fabrics,
    lines: [],
    logistics: null,
    upholstery: null,
    helper: null,
    sofaCount: p.sofaCount,
    fee: p.paymentOptionName
      ? { name: p.paymentOptionName, rateBps: 0, installments: p.installments ?? 1 }
      : null,
    totals: {
      materialsCents: 0,
      logisticsCents: 0,
      upholsteryCents: 0,
      helperCents: 0,
      laborCents: 0,
      costCents: 0,
      profitCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents: p.totalCents,
      installmentTotalCents: p.installmentTotalCents,
    },
    deliveryDays: p.deliveryDays,
    validityDays: p.validityDays,
    paymentTerms: p.paymentTerms,
    notes: p.notes,
  };
}

export function ProposalPage({ id }: { id: string }) {
  const t = useSearchParams().get('t') ?? '';
  const qc = useQueryClient();
  const key = ['proposta', id, t];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<PublicQuoteDto>(`/api/public/proposta/${id}?t=${encodeURIComponent(t)}`),
    retry: false,
  });
  const [confirm, setConfirm] = useState(false);
  const approve = useMutation({
    mutationFn: () =>
      api<PublicQuoteDto>(`/api/public/proposta/${id}/aprovar`, { method: 'POST', body: { t } }),
    onSuccess: (dto) => {
      qc.setQueryData(key, dto);
      setConfirm(false);
    },
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <NotFound what="Proposta" />;
  const p = q.data;
  const approved = p.status === 'APROVADO';
  const wa = p.companyPhone
    ? whatsappLink(p.companyPhone, `Olá! Sobre a proposta nº ${p.number} (${p.customerName}): `)
    : null;
  return (
    // Mesma largura da proposta no painel (a página dos links é mais estreita).
    <div className="relative left-1/2 w-[min(56rem,calc(100vw-2rem))] -translate-x-1/2">
      <ProposalDocument s={proposalSnapshot(p)} number={p.number} />
      <Card className="mt-6 p-5 sm:p-6">
        {!approved && p.status !== 'RECUSADO' && !p.expired && (
          <div className="mb-4">
            <p className="text-lg font-semibold">Gostou da proposta?</p>
            <p className="text-sm text-ink-muted">
              Aprove por aqui e a tapeçaria combina com você o dia de buscar a peça.
            </p>
          </div>
        )}
        <div>
          {approved ? (
            <>
              <Alert tone="ok" title="Proposta aprovada">
                {p.approvedAt
                  ? `Aprovada em ${new Date(p.approvedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}. `
                  : ''}
                A tapeçaria já foi avisada e vai combinar com você o dia de buscar a peça.
              </Alert>
            </>
          ) : p.status === 'RECUSADO' ? (
            <Alert tone="warn">Esta proposta foi encerrada. Fale com a tapeçaria.</Alert>
          ) : p.expired ? (
            <Alert tone="warn">
              Esta proposta passou da validade. Fale com a tapeçaria para receber uma nova.
            </Alert>
          ) : confirm ? (
            <div className="rounded-xl border border-line p-4">
              <p className="font-medium">
                Confirmar a aprovação da proposta nº {p.number} no valor de{' '}
                {formatCents(p.totalCents)}?
              </p>
              {approve.error && (
                <Alert tone="danger" className="mt-3">
                  {errorMessage(approve.error)}
                </Alert>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button loading={approve.isPending} onClick={() => approve.mutate()}>
                  Sim, aprovar
                </Button>
                <Button variant="secondary" onClick={() => setConfirm(false)}>
                  Voltar
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="lg"
              className="w-full"
              icon={<CheckCircle2 className="size-5" aria-hidden />}
              onClick={() => setConfirm(true)}
            >
              Aprovar proposta
            </Button>
          )}
          {wa && (
            <a
              href={wa}
              target="_blank"
              rel="noopener noreferrer"
              className={clsx(buttonClass('secondary', 'lg'), 'mt-3 w-full')}
            >
              <MessageCircle className="size-5" aria-hidden /> Tirar dúvida no WhatsApp
            </a>
          )}
        </div>
      </Card>
      <Footer />
    </div>
  );
}

// ─────────────────────────── Álbum (82) ───────────────────────────

export function AlbumPage({ id }: { id: string }) {
  const t = useSearchParams().get('t') ?? '';
  const q = useQuery({
    queryKey: ['album-publico', id, t],
    queryFn: () => api<OsAlbumDto>(`/api/public/album/${id}?t=${encodeURIComponent(t)}`),
    retry: false,
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <NotFound what="Álbum" />;
  const a = q.data;
  return (
    <>
      <CompanyHeader name={a.companyName} />
      <h1 className="text-xl font-semibold">Fotos do seu serviço</h1>
      <p className="text-sm text-ink-muted">
        {a.customerName} • {a.code}
        {a.pieces.length ? ` • ${a.pieces.join(', ')}` : ''}
      </p>
      <AlbumSections album={a} />
      <Footer />
    </>
  );
}

// ─────────────────────────── Contrato ───────────────────────────

interface PublicContract {
  code: string;
  companyName: string;
  companyPhone: string | null;
  body: string;
  signed: boolean;
  pdfUrl: string;
}

/** Contrato do serviço (mandado pelo WhatsApp): o cliente lê, baixa o PDF e responde. */
export function ContractPage({ id }: { id: string }) {
  const t = useSearchParams().get('t') ?? '';
  const q = useQuery({
    queryKey: ['contrato-publico', id, t],
    queryFn: () => api<PublicContract>(`/api/public/contrato/${id}?t=${encodeURIComponent(t)}`),
    retry: false,
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <NotFound what="Contrato" />;
  const c = q.data;
  const reply = c.companyPhone
    ? whatsappLink(c.companyPhone, `Li o contrato do serviço ${c.code} e estou de acordo.`)
    : null;
  return (
    <>
      <CompanyHeader name={c.companyName} />
      <h1 className="text-xl font-semibold">Contrato do seu serviço</h1>
      <p className="text-sm text-ink-muted">
        {c.code}
        {c.signed ? ' • assinado' : ''}
      </p>
      <Card className="mt-5 p-4">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{c.body}</p>
      </Card>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <a href={c.pdfUrl} className={buttonClass('secondary', 'md')}>
          Baixar em PDF
        </a>
        {reply && !c.signed && (
          <a
            href={reply}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('primary', 'md')}
          >
            <MessageCircle className="size-4" aria-hidden />
            Responder que estou de acordo
          </a>
        )}
      </div>
      <Footer />
    </>
  );
}

/** Seções antes / durante / depois (usada também na O.S. dentro do painel). */
export function AlbumSections({ album }: { album: OsAlbumDto }) {
  const [zoom, setZoom] = useState<OsAlbumPhoto | null>(null);
  const sections = [
    ['Antes', album.before],
    ['Durante a reforma', album.during],
    ['Pronto', album.after],
  ] as const;
  const empty = sections.every(([, list]) => !list.length);
  return (
    <div className="mt-5 space-y-6">
      {empty && <p className="text-sm text-ink-muted">Ainda não há fotos deste serviço.</p>}
      {sections.map(([title, list]) =>
        list.length ? (
          <section key={title}>
            <h2 className="mb-2 font-semibold">{title}</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {list.map((p) => (
                <button
                  key={p.fileId}
                  type="button"
                  onClick={() => setZoom(p)}
                  className="overflow-hidden rounded-xl border border-line bg-subtle"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.thumbUrl}
                    alt={p.caption ?? title}
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                </button>
              ))}
            </div>
          </section>
        ) : null,
      )}
      {zoom && (
        <button
          type="button"
          className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4"
          onClick={() => setZoom(null)}
          aria-label="Fechar foto"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoom.url}
            alt={zoom.caption ?? 'Foto do serviço'}
            className="max-h-full max-w-full rounded-lg"
          />
        </button>
      )}
    </div>
  );
}

// ─────────────────────────── Retirada (130) ───────────────────────────

export function PickupChoicePage({ id }: { id: string }) {
  const t = useSearchParams().get('t') ?? '';
  const q = useQuery({
    queryKey: ['agendar', id, t],
    queryFn: () => api<PublicPickupDto>(`/api/public/agendar/${id}?t=${encodeURIComponent(t)}`),
    retry: false,
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <NotFound what="Retirada" />;
  const p = q.data;
  // 2026-11-25: serviço feito na casa do cliente usa as palavras dele.
  const what = p.onSite ? 'do serviço no local' : 'da retirada';
  return (
    <>
      <CompanyHeader name={p.companyName} />
      <Card className="p-5 sm:p-6">
        <h1 className="text-xl font-semibold">
          {p.onSite ? 'Serviço no seu endereço' : 'Retirada das suas peças'}
        </h1>
        <p className="text-sm text-ink-muted">
          {p.customerName} • {p.code}
        </p>
        {p.address && <p className="mt-2 text-sm text-ink-soft">Endereço: {p.address}</p>}
        {p.pieces.length > 0 && (
          <p className="text-sm text-ink-soft">Peças: {p.pieces.join(', ')}</p>
        )}
        {!p.open ? (
          <Alert tone="info" className="mt-5">
            {p.onSite ? 'O serviço' : 'A retirada'} já está a caminho ou foi feito. Para mudar algo,
            fale com a tapeçaria.
          </Alert>
        ) : p.scheduledDate ? (
          <Alert
            tone="ok"
            title={p.onSite ? 'Serviço no local agendado' : 'Retirada agendada'}
            className="mt-5"
          >
            {weekday(p.scheduledDate)}, {brDay(p.scheduledDate)}
            {p.shift ? `, ${PICKUP_SHIFT_LABEL[p.shift].toLowerCase()}` : ''}. A equipe avisa quando
            estiver a caminho. Para mudar o dia, fale com a tapeçaria.
          </Alert>
        ) : (
          <Alert tone="info" className="mt-5">
            A tapeçaria vai combinar com você o dia e o horário {what}.
          </Alert>
        )}
      </Card>
      <Footer />
    </>
  );
}

// ─────────────────────────── "Como ficou?" (itens 22 e 23) ───────────────────────────

const STAR_WORD = ['', 'Ruim', 'Fraco', 'Mais ou menos', 'Bom', 'Ótimo'];

function Stars({ value, onPick }: { value: number; onPick?: (n: number) => void }) {
  return (
    <div className="flex gap-1" role={onPick ? 'radiogroup' : undefined} aria-label="Nota">
      {[1, 2, 3, 4, 5].map((n) => {
        const icon = (
          <Star
            className={clsx(
              'size-9',
              n <= value ? 'fill-amber-400 text-amber-400' : 'text-ink-muted/40',
            )}
          />
        );
        return onPick ? (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={n === value}
            aria-label={`${n} de 5`}
            data-testid={`estrela-${n}`}
            onClick={() => onPick(n)}
            className="rounded-lg p-0.5 focus-visible:outline-2"
          >
            {icon}
          </button>
        ) : (
          <span key={n}>{icon}</span>
        );
      })}
    </div>
  );
}

export function ReviewPage({ id }: { id: string }) {
  const t = useSearchParams().get('t') ?? '';
  const qc = useQueryClient();
  const key = ['avaliar', id, t];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<PublicReviewDto>(`/api/public/avaliar/${id}?t=${encodeURIComponent(t)}`),
    retry: false,
  });
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [website, setWebsite] = useState('');
  const send = useMutation({
    mutationFn: () =>
      api<PublicReviewDto>(`/api/public/avaliar/${id}`, {
        method: 'POST',
        body: {
          t,
          stars,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...(website ? { website } : {}),
        },
      }),
    onSuccess: (dto) => qc.setQueryData(key, dto),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <NotFound what="Entrega" />;
  const r = q.data;
  return (
    <>
      <CompanyHeader name={r.companyName} logo={r.logoDataUrl} />
      <Card className="p-5 sm:p-6" data-testid="avaliar-pagina">
        <h1 className="text-xl font-semibold">
          {r.customerFirstName ? `${r.customerFirstName}, como ficou?` : 'Como ficou?'}
        </h1>
        {r.pieces.length > 0 && (
          <p className="mt-1 text-sm text-ink-muted">
            {r.pieces.map((p) => p.description).join(', ')}
            {r.deliveredOn ? ` • entregue em ${brDay(r.deliveredOn)}` : ''}
          </p>
        )}
        {r.review ? (
          <div className="mt-5 space-y-3" data-testid="avaliar-obrigado">
            <Stars value={r.review.stars} />
            <Alert tone="ok" title="Obrigado pela resposta!">
              {r.review.stars <= 3
                ? 'A tapeçaria já recebeu sua nota e vai falar com você para resolver.'
                : 'Sua nota ajuda a tapeçaria a fazer cada peça melhor.'}
            </Alert>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">Que nota você dá para o serviço?</p>
              <Stars value={stars} onPick={setStars} />
              <p className="mt-1 h-5 text-sm text-ink-soft">{STAR_WORD[stars]}</p>
            </div>
            <label className="block text-sm">
              <span className="font-medium">Quer contar mais alguma coisa? (não precisa)</span>
              <Textarea
                className="mt-1"
                rows={3}
                maxLength={500}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                data-testid="avaliar-comentario"
              />
            </label>
            {/* Campo-isca: invisível para pessoas, só robô preenche. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="hidden"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
            {send.isError && <Alert tone="danger">{errorMessage(send.error)}</Alert>}
            <Button
              disabled={stars === 0}
              loading={send.isPending}
              onClick={() => send.mutate()}
              data-testid="avaliar-enviar"
            >
              Enviar nota
            </Button>
          </div>
        )}
      </Card>
      <Card className="mt-4 p-5 sm:p-6" data-testid="avaliar-cuidados">
        <h2 className="text-lg font-semibold">Cuidados com a sua peça</h2>
        <div className="mt-3 space-y-3">
          {r.care.map((c) => (
            <div key={c.fabric}>
              <p className="text-sm font-medium">{c.fabric}</p>
              <p className="text-sm text-ink-soft">{c.text}</p>
            </div>
          ))}
        </div>
      </Card>
      <Footer />
    </>
  );
}

// ─────────────────────────── Status (100) ───────────────────────────

export function StatusPage() {
  const q = useQuery({
    queryKey: ['status-publico'],
    queryFn: () => api<PublicStatusDto>('/api/public/status'),
    refetchInterval: 60_000,
    retry: false,
  });
  const down = q.isError || (q.data && !q.data.ok);
  const days = q.data?.days ?? [];
  const measured = days.filter((d) => d.uptimeBps !== null);
  const avg = measured.length
    ? measured.reduce((a, d) => a + (d.uptimeBps ?? 0), 0) / measured.length / 100
    : null;
  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        <LogoMark className="size-10" />
        <div>
          <p className="font-semibold">Cenário Gestão</p>
          <p className="text-sm text-ink-muted">Status do sistema</p>
        </div>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : (
        <Card className="p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <span
              className={clsx('size-3 rounded-full', down ? 'bg-danger-600' : 'bg-ok-600')}
              aria-hidden
            />
            <h1 className="text-lg font-semibold">
              {down ? 'Sistema com problema' : 'Sistema funcionando normalmente'}
            </h1>
          </div>
          {q.data?.notice && (
            <Alert tone="warn" className="mt-4">
              {q.data.notice.message} (de{' '}
              {new Date(q.data.notice.showFrom).toLocaleString('pt-BR', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}{' '}
              até{' '}
              {new Date(q.data.notice.showUntil).toLocaleString('pt-BR', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
              )
            </Alert>
          )}
          {down && (
            <p className="mt-2 text-sm text-ink-soft">
              A equipe já foi avisada e está trabalhando para normalizar.
            </p>
          )}
          {days.length > 0 && (
            <div className="mt-6">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">Últimos {days.length} dias</span>
                {avg !== null && (
                  <span className="text-ink-muted">
                    {avg.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% no ar
                  </span>
                )}
              </div>
              <div className="mt-2 flex h-8 gap-[2px]">
                {days.map((d) => (
                  <span
                    key={d.day}
                    title={`${brDay(d.day)}: ${d.uptimeBps === null ? 'sem medição' : `${(d.uptimeBps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% no ar`}`}
                    className={clsx(
                      'flex-1 rounded-sm',
                      d.uptimeBps === null
                        ? 'bg-line'
                        : d.uptimeBps >= 9990
                          ? 'bg-ok-600'
                          : d.uptimeBps >= 9800
                            ? 'bg-warn-600'
                            : 'bg-danger-600',
                    )}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-xs text-ink-muted">
                <span>{brDay(days[0]!.day)}</span>
                <span>Hoje</span>
              </div>
            </div>
          )}
          {q.data && (
            <p className="mt-4 text-xs text-ink-muted">
              Verificado às{' '}
              {new Date(q.data.checkedAt).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {q.data.latencyMs !== null ? ` • resposta em ${q.data.latencyMs} ms` : ''}
            </p>
          )}
        </Card>
      )}
    </>
  );
}
