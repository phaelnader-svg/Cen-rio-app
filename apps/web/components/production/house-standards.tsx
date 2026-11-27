'use client';

import {
  PRODUCTION_ACTIVITIES,
  PRODUCTION_ACTIVITY_LABEL,
  type HouseStandardDto,
  type ProductionActivity,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ImagePlus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Alert, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

/**
 * Item 20 (lista de 53): padrão da casa. Para cada etapa, um texto curto e uma foto ou um vídeo
 * curto de como a oficina faz. O tapeceiro vê na tarefa do tablet.
 */
const KEY = ['house-standards'];

export function useHouseStandards() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<{ items: HouseStandardDto[] }>('/api/v1/house-standards'),
    staleTime: 5 * 60_000,
  });
}

function Media({ s, large }: { s: Pick<HouseStandardDto, 'fileUrl' | 'mime'>; large?: boolean }) {
  if (!s.fileUrl) return null;
  const cls = large
    ? 'max-h-[60vh] w-full rounded-xl object-contain bg-black/5'
    : 'max-h-56 rounded-lg';
  return s.mime?.startsWith('video/') ? (
    <video src={s.fileUrl} controls playsInline preload="metadata" className={cls} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={s.fileUrl} alt="" className={cls} />
  );
}

export function HouseStandardsPanel() {
  const q = useHouseStandards();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const by = new Map(q.data.items.map((i) => [i.activity, i]));
  return (
    <div className="space-y-4" data-testid="padrao-casa">
      <p className="max-w-3xl text-sm text-ink-soft">
        Mostre como a oficina faz cada etapa: um texto curto e uma foto ou um vídeo de uns 15
        segundos. O tapeceiro vê na tarefa do tablet, e quem está começando aprende sem parar o mais
        experiente. Deixe em branco as etapas que não precisam.
      </p>
      {PRODUCTION_ACTIVITIES.map((a) => (
        <StandardForm key={`${a}:${by.get(a)?.updatedAt ?? ''}`} activity={a} current={by.get(a)} />
      ))}
    </div>
  );
}

function StandardForm({
  activity,
  current,
}: {
  activity: ProductionActivity;
  current: HouseStandardDto | undefined;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(current?.text ?? '');
  const [file, setFile] = useState<{
    fileId: string | null;
    fileUrl: string | null;
    mime: string | null;
  }>({
    fileId: current?.fileId ?? null,
    fileUrl: current?.fileUrl ?? null,
    mime: current?.mime ?? null,
  });
  const upload = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append('file', f);
      return api<{ fileId: string; fileUrl: string; mime: string }>(
        '/api/v1/house-standards/upload',
        { method: 'POST', body: fd },
      );
    },
    onSuccess: (r) => setFile(r),
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/house-standards/${activity}`, {
        method: 'PUT',
        body: { text, fileId: file.fileId },
      }),
    onSuccess: () => {
      toast('ok', `Padrão de ${PRODUCTION_ACTIVITY_LABEL[activity].toLowerCase()} salvo.`);
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const changed = text !== (current?.text ?? '') || file.fileId !== (current?.fileId ?? null);
  return (
    <Card className="p-4" data-testid={`padrao-${activity}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{PRODUCTION_ACTIVITY_LABEL[activity]}</h3>
        {current?.updatedByName && (
          <p className="text-xs text-ink-muted">Atualizado por {current.updatedByName}</p>
        )}
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-[1fr_260px]">
        <Textarea
          rows={4}
          maxLength={1500}
          placeholder="Ex.: grampo a cada 2 dedos, começar pelo meio e puxar para as pontas."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="space-y-2">
          <Media s={file} />
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={upload.isPending}
              onClick={() => input.current?.click()}
            >
              <ImagePlus className="size-4" aria-hidden />
              {file.fileId ? 'Trocar foto ou vídeo' : 'Pôr foto ou vídeo'}
            </Button>
            {file.fileId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFile({ fileId: null, fileUrl: null, mime: null })}
              >
                <Trash2 className="size-4" aria-hidden /> Tirar
              </Button>
            )}
          </div>
        </div>
      </div>
      {(upload.isError || save.isError) && (
        <Alert tone="danger" className="mt-3">
          {errorMessage(upload.error ?? save.error)}
        </Alert>
      )}
      {changed && (
        <Button className="mt-3" loading={save.isPending} onClick={() => save.mutate()}>
          Salvar
        </Button>
      )}
    </Card>
  );
}

/** Na tarefa do tablet: botão "Padrão da casa" que abre o texto e a foto ou o vídeo. */
export function HouseStandardButton({ activity }: { activity: string }) {
  const q = useHouseStandards();
  const [open, setOpen] = useState(false);
  const s = q.data?.items.find((i) => i.activity === activity);
  if (!s) return null;
  return (
    <div className="mt-4" data-testid="padrao-casa-tarefa">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-12 items-center gap-2 rounded-xl border border-brand-600/30 bg-brand-50 px-4 text-lg font-semibold text-brand-700"
        aria-expanded={open}
      >
        <BookOpen className="size-5" aria-hidden /> Padrão da casa
      </button>
      {open && (
        <div className="mt-3 space-y-3 rounded-xl border border-line bg-surface p-4">
          {s.text && <p className="whitespace-pre-line text-lg">{s.text}</p>}
          <Media s={s} large />
        </div>
      )}
    </div>
  );
}
