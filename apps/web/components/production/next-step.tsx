'use client';

import {
  NEXT_STEP_DONE,
  NEXT_STEP_LABEL,
  NEXT_STEP_PERMISSION,
  customerMessage,
  whatsappLink,
  type AdvanceServiceOrderResultDto,
  type NextStep,
  type OsAlbumDto,
  type Permission,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  CheckCircle2,
  Hammer,
  MessageCircle,
  PackageCheck,
  Play,
  Truck,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonClass } from '@/components/ui/button-styles';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { useCustomer } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { uploadPhoto } from '@/lib/photos';
import { useCompany } from '@/lib/queries';

/**
 * Oficina sem tablet (2026-11-24): o botão verde da próxima etapa (um clique). Grava pelos mesmos
 * caminhos do tablet, da qualidade e da entrega, no nome do tapeceiro; o histórico guarda quem
 * marcou. Depois de "Ficou pronta", abre a foto (opcional) e o aviso ao cliente no WhatsApp.
 */
const ICON: Record<NextStep, typeof Play> = {
  COMECOU: Play,
  PRONTA: Hammer,
  APROVADA: CheckCircle2,
  SAIU: Truck,
  ENTREGUE: PackageCheck,
};

export interface NextStepOs {
  id: string;
  code: string;
  nextStep?: NextStep | null;
  customer: { id: string; name: string };
  pieces?: string | null;
}

/** Atualiza as telas que mostram o andamento da OS. */
export function useInvalidateOs() {
  const qc = useQueryClient();
  return (id?: string) => {
    for (const key of [
      ['service-orders'],
      ['service-order'],
      ['shop-floor'],
      ['operational-state'],
      ['direct-delivery'],
      ['pieces'],
      ['production-pipeline'],
      ['notifications'],
      ['os-album'],
    ])
      void qc.invalidateQueries({ queryKey: key });
    if (id) void qc.invalidateQueries({ queryKey: ['service-order', id] });
  };
}

export function advanceOs(
  id: string,
  step: NextStep,
  extra: { pickedUpByCustomer?: boolean } = {},
) {
  return api<AdvanceServiceOrderResultDto>(`/api/v1/service-orders/${id}/next-step`, {
    method: 'POST',
    idempotencyKey: newIdempotencyKey(),
    body: { step, ...extra },
  });
}

export function useCanStep() {
  const can = useCan();
  return (step: NextStep) => can(NEXT_STEP_PERMISSION[step] as Permission);
}

export function NextStepButton({
  os,
  size = 'sm',
  full = false,
}: {
  os: NextStepOs;
  size?: 'sm' | 'md' | 'lg';
  full?: boolean;
}) {
  const toast = useToast();
  const invalidate = useInvalidateOs();
  const canStep = useCanStep();
  const [ready, setReady] = useState<AdvanceServiceOrderResultDto | null>(null);
  const m = useMutation({
    mutationFn: (v: { step: NextStep; pickedUpByCustomer?: boolean }) =>
      advanceOs(os.id, v.step, v.pickedUpByCustomer ? { pickedUpByCustomer: true } : {}),
    onSuccess: (r, v) => {
      invalidate(os.id);
      if (!r.done) {
        toast('ok', `${os.code} já tinha passado desta etapa.`);
        return;
      }
      toast(
        'ok',
        v.pickedUpByCustomer
          ? `${os.code}: entregue (cliente buscou).`
          : `${os.code} ${NEXT_STEP_DONE[r.done]}${r.done === 'COMECOU' && r.upholsterer ? ` com ${r.upholsterer}` : ''}.`,
      );
      if (r.done === 'PRONTA') setReady(r);
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const step = os.nextStep;
  return (
    <>
      {step && canStep(step) && (
        <span className={full ? 'grid w-full gap-2' : 'inline-flex gap-2'}>
          <NextStepMainButton
            step={step}
            size={size}
            full={full}
            loading={m.isPending && m.variables?.step === step && !m.variables.pickedUpByCustomer}
            onClick={() => m.mutate({ step })}
            testId={`next-step-${os.code}`}
          />
          {step === 'SAIU' && canStep('ENTREGUE') && (
            <Button
              size={size}
              variant="secondary"
              className={full ? 'w-full' : undefined}
              loading={m.isPending && Boolean(m.variables?.pickedUpByCustomer)}
              onClick={() => m.mutate({ step: 'ENTREGUE', pickedUpByCustomer: true })}
              data-testid={`picked-up-${os.code}`}
            >
              Cliente buscou
            </Button>
          )}
        </span>
      )}
      {ready && <ReadyDialog os={os} result={ready} onClose={() => setReady(null)} />}
    </>
  );
}

export function NextStepMainButton({
  step,
  size,
  full,
  loading,
  onClick,
  testId,
}: {
  step: NextStep;
  size: 'sm' | 'md' | 'lg';
  full?: boolean;
  loading?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  const Icon = ICON[step];
  return (
    <Button
      size={size}
      className={full ? 'w-full' : undefined}
      loading={loading}
      icon={<Icon className="size-4" aria-hidden />}
      onClick={onClick}
      data-testid={testId}
    >
      {NEXT_STEP_LABEL[step]}
    </Button>
  );
}

/**
 * Depois de "Ficou pronta": foto do serviço pronto (opcional, vai para o álbum da OS) e o aviso
 * ao cliente pelo WhatsApp com a mensagem pronta e o link das fotos. No celular, a foto pode ir
 * junto na própria conversa (compartilhar).
 */
function ReadyDialog({
  os,
  result,
  onClose,
}: {
  os: NextStepOs;
  result: AdvanceServiceOrderResultDto;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateOs();
  const customer = useCustomer(os.customer.id);
  const company = useCompany(true);
  const input = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [albumUrl, setAlbumUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!result.photoTarget) throw new Error('Não foi possível guardar a foto nesta OS.');
      await uploadPhoto({ ...result.photoTarget, file, caption: 'Serviço pronto' });
      const album = await api<OsAlbumDto & { shareUrl: string }>(
        `/api/v1/service-orders/${os.id}/album`,
      );
      return album.shareUrl;
    },
    onSuccess: (url, file) => {
      setPhoto(file);
      setAlbumUrl(url);
      setError(null);
      invalidate(os.id);
      toast('ok', 'Foto guardada na OS.');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const phone = customer.data?.whatsapp || customer.data?.phone || null;
  const base = customerMessage({
    kind: 'PRONTO',
    customerName: os.customer.name,
    companyName: company.data?.tradeName ?? '',
    piece: os.pieces ?? null,
    code: os.code,
  });
  const text = albumUrl ? `${base}\n\nFoto do serviço: ${albumUrl}` : base;
  const canShareFile =
    photo &&
    typeof navigator !== 'undefined' &&
    'canShare' in navigator &&
    navigator.canShare({ files: [photo] });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${os.code} ficou pronta`}
      description={`Tire uma foto do serviço, se quiser, e avise ${os.customer.name.split(' ')[0]} pelo WhatsApp.`}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="space-y-3">
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          data-testid="ready-photo-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = '';
          }}
        />
        {photo ? (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-subtle px-4 py-3 text-sm">
            <CheckCircle2 className="size-5 text-ok-600" aria-hidden />
            <span className="flex-1">Foto guardada no álbum da OS.</span>
            <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
              Trocar
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="w-full"
            size="lg"
            loading={upload.isPending}
            icon={<Camera className="size-5" aria-hidden />}
            onClick={() => input.current?.click()}
            data-testid="ready-photo"
          >
            Tirar foto do serviço pronto
          </Button>
        )}
        {canShareFile ? (
          <Button
            size="lg"
            className="w-full"
            icon={<MessageCircle className="size-5" aria-hidden />}
            onClick={() => {
              void navigator.share({ files: [photo], text: base }).catch(() => undefined);
            }}
          >
            Enviar a foto no WhatsApp
          </Button>
        ) : (
          <a
            href={whatsappLink(phone, text)}
            target="_blank"
            rel="noopener noreferrer"
            className={`${buttonClass('primary', 'lg')} w-full`}
            data-testid="ready-whatsapp"
          >
            <MessageCircle className="size-5" aria-hidden />
            Avisar {os.customer.name.split(' ')[0]} no WhatsApp
          </a>
        )}
        <p className="text-xs text-ink-muted">
          {phone
            ? 'O WhatsApp abre com a mensagem pronta; quem envia é você.'
            : 'O cliente não tem telefone no cadastro: o WhatsApp abre para você escolher o contato.'}
        </p>
      </div>
    </Dialog>
  );
}
