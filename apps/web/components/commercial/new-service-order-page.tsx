'use client';

import { QUOTE_DEFAULT_NOTES } from '@cenario/shared';
import type { Priority, ServiceOrderDto, ServiceType } from '@cenario/shared';
import { PRIORITIES, PRIORITY_LABEL, createServiceOrderSchema } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Camera, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DateField,
  FormActions,
  FormGrid,
  FormSection,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui/form';
import { Alert, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { useAvailableForOs, type AvailableForOs } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { uploadPhoto } from '@/lib/photos';
import { useEmployees } from '@/lib/queries';
import { fabricText, WorkChecks, WorkMaterials } from './quote-work';
import { BackLink } from './section';

/**
 * 2026-11-19 (Raphael): gerar OS em 5 partes, cada informação uma vez só. O serviço (o que o
 * orçamento aprovado diz: serviço do tapeceiro, peças, o que fazer, tecido, materiais com
 * medidas, foto) aparece travado; preenche-se só o que falta: tapeceiro e mão de obra por peça,
 * prazo, prioridade, material, fotos e um recado. O responsável da OS é o próprio tapeceiro e a
 * mão de obra é liberada na aprovação da qualidade. Titular e mão de obra são gravados na mesma
 * operação da OS (atômica). Nenhum pagamento é liberado na criação.
 */

export function NewServiceOrderPage() {
  const params = useSearchParams();
  const orderId = params.get('pedido');
  const can = useCan();
  const available = useAvailableForOs(orderId);
  if (!can('os.gerenciar')) return <Alert tone="warn">Você não tem permissão para criar OS.</Alert>;
  if (!orderId)
    return (
      <>
        <PageHeader
          title="Gerar ordem de serviço"
          description="Gere a OS das peças que já chegaram na tapeçaria."
        />
        <Alert tone="info">
          Abra um pedido com a peça já na tapeçaria e use “Gerar ordem de serviço”.{' '}
          <Link href="/painel/pedidos" className="font-semibold text-brand-700 hover:underline">
            Ir para Pedidos comerciais
          </Link>
        </Alert>
      </>
    );
  if (available.isPending) return <Spinner />;
  if (available.isError) return <Alert tone="danger">{available.error.message}</Alert>;
  return (
    <>
      <BackLink href={`/painel/pedidos/${orderId}`} label={`Pedido ${available.data.order.code}`} />
      <PageHeader
        title="Gerar ordem de serviço"
        description={`${available.data.customer.name} · ${available.data.order.contractedService}`}
      />
      {available.data.items.every((i) => i.available <= 0) ? (
        <Alert tone="info">Todas as peças deste pedido já estão em OS.</Alert>
      ) : (
        <ServiceOrderForm data={available.data} />
      )}
    </>
  );
}

type Item = AvailableForOs['items'][number];
type QuoteInfo = AvailableForOs['quote'];

interface Row {
  key: string;
  orderItemId: string;
  quantity: number;
  description: string;
  serviceType: ServiceType;
  fabricName: string;
  fabricColor: string;
  fabricReference: string;
  technicalNotes: string;
  upholstererUserId: string;
  laborCents: number | null;
  laborValid: boolean;
}

/**
 * Tipo de serviço puxado do orçamento: o que ele manda trocar. Sem orçamento, reforma completa.
 */
function serviceTypeOf(i: Item, quote: QuoteInfo): ServiceType {
  if (i.serviceType) return i.serviceType;
  const yes = (label: string) =>
    quote?.work.checks.some((c) => c.label === label && c.value === 'Sim');
  const fabric = yes('Trocar tecido');
  const foam = yes('Trocar espuma');
  if (fabric && !foam) return 'TROCA_DE_TECIDO';
  if (foam && !fabric) return 'TROCA_DE_ESPUMA';
  return 'REFORMA_COMPLETA';
}

/** Cada peça que chegou entra na OS com o que o pedido e o orçamento já dizem. */
function prefilledRow(i: Item, quote: QuoteInfo, single: boolean): Row {
  const owner = i.plannedUpholstererUserId ?? (single ? (quote?.upholstererUserId ?? '') : '');
  return {
    key: i.orderItemId,
    orderItemId: i.orderItemId,
    quantity: i.available,
    description: i.description,
    serviceType: serviceTypeOf(i, quote),
    fabricName: i.fabricName ?? quote?.work.fabricName ?? '',
    fabricColor: i.fabricColor ?? '',
    fabricReference: i.fabricReference ?? '',
    // Só o que alguém escreveu na peça (nada de texto automático repetido).
    technicalNotes: i.technicalNotes ?? '',
    upholstererUserId: owner,
    laborCents:
      i.plannedUpholstererUserId && i.plannedLaborUnitCents
        ? i.plannedLaborUnitCents * i.available
        : null,
    laborValid: true,
  };
}

/**
 * Observação própria do pedido. O texto montado ao fechar o serviço ("Orçamento nº…, tecido,
 * troca de espuma…") repete o orçamento, que já aparece em partes nesta tela: fica de fora.
 */
function ownOrderNotes(order: AvailableForOs['order'], quote: QuoteInfo): string {
  const text = (order.technicalNotes ?? '').replace(QUOTE_DEFAULT_NOTES.trim(), '').trim();
  if (quote && /^Orçamento nº/i.test(text)) return '';
  return text;
}

function ServiceOrderForm({ data }: { data: AvailableForOs }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const employees = useEmployees(can('funcionarios.ver'));
  const quote = data.quote;
  const work = quote?.work ?? null;
  const usable = data.items.filter((i) => i.available > 0);
  const [rows, setRows] = useState<Row[]>(() =>
    usable.map((i) => prefilledRow(i, quote, usable.length === 1)),
  );
  const [priority, setPriority] = useState<Priority>('NORMAL');
  const [promisedDate, setPromisedDate] = useState(data.order.promisedDate ?? '');
  const [notes, setNotes] = useState('');
  // Fotos da OS: a do orçamento (vai junto por padrão) e as que forem acrescentadas aqui.
  const [useQuotePhoto, setUseQuotePhoto] = useState(Boolean(quote?.photoDataUrl));
  const [photos, setPhotos] = useState<File[]>([]);
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  // Padrão: falta comprar (a OS espera o "Material comprado"); orçamento sem material = comprado.
  const [materialPurchased, setMaterialPurchased] = useState<boolean>(
    Boolean(work && work.materials.length === 0),
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const idem = useRef(newIdempotencyKey());
  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const perms = data.permissions;
  const byUser = new Map(data.upholsterers.map((u) => [u.userId, u]));
  const orderNotes = ownOrderNotes(data.order, quote);
  const laborInvalid = rows.some((r) => !r.laborValid);
  const many = rows.length > 1;
  const service = work?.upholsteryService || data.order.contractedService;
  // Sem repetir: a peça só aparece se for diferente do serviço; o tecido, se não estiver na
  // lista de materiais (que já traz a metragem).
  const showPieces = many || rows[0]?.quantity !== 1 || rows[0]?.description !== service;
  const fabric = (rows[0]?.fabricName || work?.fabricName || '').trim().toLowerCase();
  const showFabric =
    !work ||
    Boolean(rows[0]?.fabricColor) ||
    !work.materials.some((m) => m.name.trim().toLowerCase() === fabric);

  // Responsável da OS = o tapeceiro escolhido (um só lugar para escolher).
  const leadId = useMemo(() => {
    const owner = rows.find((r) => r.upholstererUserId)?.upholstererUserId;
    const emp = owner ? employees.data?.find((e) => e.active && e.userId === owner) : undefined;
    return emp?.id ?? quote?.technicalLeadId ?? null;
  }, [rows, employees.data, quote]);

  const m = useMutation({
    mutationFn: () => {
      const body = createServiceOrderSchema.parse({
        orderId: data.order.id,
        priority,
        promisedDate: promisedDate || null,
        technicalLeadId: leadId,
        technicalInstructions: orderNotes,
        notes,
        materialPurchased,
        materialsFromQuote: Boolean(work?.materials.length),
        items: rows.map((r) => ({
          orderItemId: r.orderItemId,
          quantity: r.quantity,
          description: r.description,
          serviceType: r.serviceType,
          fabricName: r.fabricName,
          fabricColor: r.fabricColor,
          fabricReference: r.fabricReference,
          foamSpecs: '',
          technicalNotes: r.technicalNotes,
          ...(perms.upholsterer && r.upholstererUserId
            ? { upholstererUserId: r.upholstererUserId }
            : {}),
          ...(perms.labor && r.upholstererUserId && r.laborCents
            ? { labor: { agreedCents: r.laborCents, eligibility: 'QUALIDADE_APROVADA' } }
            : {}),
        })),
      });
      return api<ServiceOrderDto>('/api/v1/service-orders', {
        method: 'POST',
        body,
        idempotencyKey: idem.current,
      });
    },
    onSuccess: async (so) => {
      // A OS já existe: uma foto que falhe não desfaz nada (dá para enviar de novo na OS).
      let photoError = false;
      const files = [...photos];
      if (useQuotePhoto && quote?.photoDataUrl)
        files.unshift(dataUrlToFile(quote.photoDataUrl, `orcamento-${quote.number}`));
      for (const file of files) {
        try {
          await uploadPhoto({ entityType: 'SERVICE_ORDER', entityId: so.id, file, caption: '' });
        } catch {
          photoError = true;
        }
      }
      if (photoError)
        toast('danger', 'A OS foi criada, mas alguma foto não subiu. Envie de novo na OS.');
      void qc.invalidateQueries({ queryKey: ['service-orders'] });
      void qc.invalidateQueries({ queryKey: ['order', data.order.id] });
      void qc.invalidateQueries({ queryKey: ['finance'] });
      toast('ok', `OS ${so.code} criada.`);
      router.push(`/painel/os/${so.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError) idem.current = newIdempotencyKey();
      const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
      if (issues) {
        const map: Record<string, string> = {};
        for (const i of issues) map[i.path.map(String).join('.')] ??= i.message;
        setFieldErrors(map);
      }
      setError(
        e instanceof ApiError
          ? e.message
          : (issues?.[0]?.message ?? (e instanceof Error ? e.message : 'Revise os dados da OS.')),
      );
    },
  });
  const err = (idx: number, f: string) => fieldErrors[`items.${idx}.${f}`];

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setFieldErrors({});
        m.mutate();
      }}
      data-testid="new-service-order"
    >
      {error && (
        <Alert tone="danger" title="A OS não foi criada">
          {error} Nada foi gravado: corrija e tente de novo.
        </Alert>
      )}

      {/* 1. O serviço: tudo o que já foi decidido no orçamento, travado (não se digita de novo). */}
      <FormSection
        step={1}
        title="O serviço"
        id="os-servico"
        description={
          quote
            ? `Vem do orçamento nº ${quote.number} aprovado pelo cliente. Para mudar, altere o pedido.`
            : 'Vem do pedido. Para mudar, altere o pedido.'
        }
        actions={
          <Link
            href={`/painel/pedidos/${data.order.id}`}
            className="text-sm font-semibold text-brand-700 hover:underline"
          >
            Pedido {data.order.code}
          </Link>
        }
      >
        <div
          className="rounded-xl border border-line bg-subtle/40 p-4 sm:p-5"
          data-testid="so-service-summary"
        >
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-[9rem_1fr]">
            <Fact label="Serviço">
              <span className="text-base font-semibold">{service}</span>
            </Fact>
            {showPieces && (
              <Fact label={many || (rows[0]?.quantity ?? 0) > 1 ? 'Peças' : 'Peça'}>
                <ul className="space-y-0.5">
                  {rows.map((r) => (
                    <li key={r.key}>
                      {r.quantity}× {r.description}
                    </li>
                  ))}
                </ul>
              </Fact>
            )}
            {work && work.checks.length > 0 && (
              <Fact label="O que fazer">
                <WorkChecks checks={work.checks} />
              </Fact>
            )}
            {showFabric && (
              <Fact label="Tecido">
                {fabricText(rows[0]?.fabricName || work?.fabricName, work?.fabricMeters ?? null)}
                {rows[0]?.fabricColor ? ` · cor ${rows[0].fabricColor}` : ''}
              </Fact>
            )}
            {work && (
              <Fact label="Materiais">
                <WorkMaterials materials={work.materials} />
              </Fact>
            )}
            {(work?.notes || orderNotes) && (
              <Fact label="Observação">
                <span className="whitespace-pre-line">
                  {[work?.notes, orderNotes].filter(Boolean).join('\n')}
                </span>
              </Fact>
            )}
          </dl>
        </div>
      </FormSection>

      {/* 2. Quem faz: o tapeceiro escolhido uma vez por peça, com a mão de obra ao lado. */}
      <FormSection
        step={2}
        title="Tapeceiro"
        id="os-tapeceiro"
        description={
          perms.labor
            ? 'Quem vai fazer e quanto ele recebe. A mão de obra é paga depois que a peça passa na qualidade.'
            : 'Quem vai fazer o serviço.'
        }
      >
        {!perms.upholsterer ? (
          <Alert tone="info">
            Quem escolhe o tapeceiro é quem planeja a produção. A OS pode ser gerada agora e o
            tapeceiro escolhido depois, na semana da oficina.
          </Alert>
        ) : (
          <ul className="space-y-3">
            {rows.map((r, idx) => {
              const owner = byUser.get(r.upholstererUserId);
              return (
                <li key={r.key} data-testid={`so-row-${idx}`}>
                  <FormGrid>
                    {many && (
                      <TextField
                        label="Peça"
                        cols={4}
                        value={`${r.quantity}× ${r.description}`}
                        readOnly
                        tabIndex={-1}
                      />
                    )}
                    <SelectField
                      label="Tapeceiro"
                      cols={many ? 4 : 6}
                      data-testid={`so-owner-${idx}`}
                      value={r.upholstererUserId}
                      error={err(idx, 'upholstererUserId')}
                      onChange={(e) => setRow(r.key, { upholstererUserId: e.target.value })}
                    >
                      <option value="">Escolher depois</option>
                      {data.upholsterers.map((u) => (
                        <option key={u.userId} value={u.userId}>
                          {u.displayName}
                        </option>
                      ))}
                    </SelectField>
                    {perms.labor && (
                      <MoneyField
                        label="Mão de obra"
                        cols={many ? 4 : 6}
                        cents={r.laborCents}
                        disabled={!owner || !owner.isTapeceiro}
                        error={
                          !r.laborValid
                            ? 'Valor inválido.'
                            : (err(idx, 'labor') ?? err(idx, 'labor.agreedCents'))
                        }
                        hint={
                          !owner
                            ? 'Escolha o tapeceiro primeiro'
                            : !owner.isTapeceiro
                              ? 'Só tapeceiro recebe por peça.'
                              : 'Em branco = combinar depois'
                        }
                        data-testid={`so-labor-value-${idx}`}
                        onCents={(v, ok) => setRow(r.key, { laborCents: v, laborValid: ok })}
                      />
                    )}
                  </FormGrid>
                </li>
              );
            })}
          </ul>
        )}
      </FormSection>

      {/* 3. Prazo e material. */}
      <FormSection step={3} title="Prazo e material" id="os-prazo">
        <FormGrid>
          <DateField
            label="Entregar até"
            cols={4}
            value={promisedDate}
            hint={data.order.promisedDate ? 'Prazo combinado no serviço' : undefined}
            onChange={(e) => setPromisedDate(e.target.value)}
          />
          <SelectField
            label="Prioridade"
            cols={3}
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
          >
            {PRIORITIES.map((x) => (
              <option key={x} value={x}>
                {PRIORITY_LABEL[x]}
              </option>
            ))}
          </SelectField>
          <div className="field sm:col-span-5" role="radiogroup" aria-label="Material">
            <span className="label">Material</span>
            <div className="grid grid-cols-2 gap-2">
              {[
                { v: true, label: 'Já comprado' },
                { v: false, label: 'Falta comprar' },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  role="radio"
                  aria-checked={materialPurchased === o.v}
                  data-testid={o.v ? 'so-material-purchased' : 'so-material-missing'}
                  onClick={() => setMaterialPurchased(o.v)}
                  className={clsx(
                    'h-11 rounded-xl border text-sm font-semibold transition-colors',
                    materialPurchased === o.v
                      ? o.v
                        ? 'border-ok-600 bg-ok-50 text-ok-600'
                        : 'border-warn-600 bg-warn-50 text-warn-600'
                      : 'border-line bg-surface text-ink-soft hover:bg-subtle',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="field-msg">
              {!materialPurchased && (
                <span className="text-xs text-ink-muted">
                  A OS entra na semana da oficina depois do “Material comprado”.
                </span>
              )}
            </div>
          </div>
        </FormGrid>
      </FormSection>

      {/* 4. Fotos da peça: um lugar que parece mesmo para pôr foto. */}
      <FormSection
        step={4}
        title="Fotos da peça"
        id="os-fotos"
        description="Ajudam o tapeceiro a ver como a peça chegou. Dá para pôr mais fotos depois, na OS."
      >
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {quote?.photoDataUrl && useQuotePhoto && (
            <PhotoTile
              src={quote.photoDataUrl}
              label="Foto do orçamento"
              onRemove={() => setUseQuotePhoto(false)}
            />
          )}
          {previews.map((src, i) => (
            <PhotoTile
              key={src}
              src={src}
              label={photos[i]?.name ?? 'Foto'}
              onRemove={() => setPhotos(photos.filter((_, j) => j !== i))}
            />
          ))}
          <li>
            <label
              htmlFor="so-photos"
              className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-strong bg-subtle/40 text-sm font-semibold text-brand-700 transition-colors hover:border-brand-600 hover:bg-brand-50"
            >
              <Camera className="size-7" aria-hidden />
              Adicionar foto
              <span className="text-xs font-normal text-ink-muted">tirar ou escolher</span>
            </label>
            <input
              id="so-photos"
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={(e) => {
                setPhotos([...photos, ...Array.from(e.target.files ?? [])]);
                e.target.value = '';
              }}
              data-testid="so-photos"
            />
          </li>
        </ul>
        {quote?.photoDataUrl && !useQuotePhoto && (
          <button
            type="button"
            className="mt-3 text-sm font-semibold text-brand-700 hover:underline"
            onClick={() => setUseQuotePhoto(true)}
            data-testid="so-quote-photo"
          >
            Voltar a foto do orçamento
          </button>
        )}
      </FormSection>

      {/* 5. Recado para quem vai fazer (opcional). */}
      <FormSection step={5} title="Recado para o tapeceiro" id="os-recado">
        <TextAreaField
          label="Recado"
          hint="Opcional. Ex.: cliente pediu costura dupla no assento."
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </FormSection>

      <FormActions>
        <Button variant="secondary" onClick={() => router.back()}>
          Cancelar
        </Button>
        <Button type="submit" size="lg" loading={m.isPending} disabled={laborInvalid}>
          Gerar OS
        </Button>
      </FormActions>
    </form>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="font-medium text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

function PhotoTile({ src, label, onRemove }: { src: string; label: string; onRemove: () => void }) {
  return (
    <li className="relative">
      {/* eslint-disable-next-line @next/next/no-img-element -- prévia local */}
      <img
        src={src}
        alt={label}
        className="aspect-[4/3] w-full rounded-xl border border-line object-cover"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Tirar ${label}`}
        className="absolute top-2 right-2 flex size-8 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
      >
        <X className="size-4" aria-hidden />
      </button>
      <p className="mt-1 truncate text-xs text-ink-muted">{label}</p>
    </li>
  );
}

/** Foto guardada no orçamento (data URL) → arquivo para o envio normal de fotos. */
function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, body] = dataUrl.split(',');
  const type = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'image/jpeg';
  const bin = atob(body ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], `${name}.${type === 'image/png' ? 'png' : 'jpg'}`, { type });
}
