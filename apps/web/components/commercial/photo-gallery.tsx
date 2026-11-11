'use client';

import type { AttachmentDto, AttachmentEntity } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, ChevronLeft, ChevronRight, ExternalLink, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useAttachments } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { uploadPhoto } from '@/lib/photos';

/** Fotografias de um registro (armazenamento privado, leitura autenticada). */
export function PhotoGallery({
  entityType,
  entityId,
  canManage,
}: {
  entityType: AttachmentEntity;
  entityId: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const photos = useAttachments(entityType, entityId);
  const input = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      // Fase 2: cada foto é reduzida no navegador antes de subir; o servidor trata de novo.
      for (const file of files) await uploadPhoto({ entityType, entityId, file, caption });
    },
    onSuccess: () => {
      setCaption('');
      setError(null);
      refresh();
    },
    onError: (e) => {
      setError(errorMessage(e));
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/attachments/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <div>
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {photos.isPending ? (
        <Spinner />
      ) : photos.isError ? (
        <Alert tone="danger">{photos.error.message}</Alert>
      ) : photos.data.length === 0 ? (
        <EmptyState icon={<Camera className="size-5" aria-hidden />} title="Nenhuma foto" />
      ) : (
        <ul
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          data-testid="photo-list"
        >
          {photos.data.map((p, i) => (
            <li
              key={p.id}
              className="group relative overflow-hidden rounded-xl border border-line bg-subtle"
            >
              <button
                type="button"
                className="block w-full"
                aria-label={`Ampliar ${p.caption ?? 'foto'}`}
                onClick={() => setViewing(i)}
              >
                {/* Fase 2: a grade carrega só a miniatura; a foto inteira abre no visualizador. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.thumbUrl}
                  alt={p.caption ?? 'Foto'}
                  loading="lazy"
                  decoding="async"
                  className="aspect-square w-full object-cover"
                />
              </button>
              <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-ink-muted">
                <span className="min-w-0 flex-1 truncate">{p.caption ?? p.createdBy ?? ''}</span>
                {canManage && (
                  <button
                    type="button"
                    aria-label="Remover foto"
                    className="rounded p-1 hover:bg-line hover:text-danger-600"
                    onClick={() => remove.mutate(p.id)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {viewing !== null && photos.data && photos.data[viewing] && (
        <PhotoViewer
          photos={photos.data}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
      {canManage && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className="input input-sm max-w-xs"
            placeholder="Legenda (opcional)"
            aria-label="Legenda da foto"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            aria-label="Selecionar fotos"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) upload.mutate(files);
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            loading={upload.isPending}
            icon={<Camera className="size-3.5" aria-hidden />}
            onClick={() => input.current?.click()}
          >
            Adicionar fotos
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Fase 2: visualizador de fotos. Mostra a foto inteira (já tratada no servidor) com legenda,
 * autor e data; anterior/próxima pelos botões, pelas setas do teclado ou deslizando; Esc fecha.
 */
export function PhotoViewer({
  photos,
  index,
  onIndex,
  onClose,
}: {
  photos: AttachmentDto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const p = photos[index]!;
  const total = photos.length;
  const go = useCallback(
    (delta: number) => onIndex((index + delta + total) % total),
    [index, total, onIndex],
  );
  const close = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Foto ${index + 1} de ${total}`}
      data-testid="photo-viewer"
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const start = touchX.current;
        const end = e.changedTouches[0]?.clientX;
        touchX.current = null;
        if (start !== null && end !== undefined && Math.abs(end - start) > 60)
          go(end < start ? 1 : -1);
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className="tabular-nums" data-testid="photo-viewer-count">
          {index + 1} de {total}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {p.caption ?? ''}
          {p.createdBy ? ` · ${p.createdBy}` : ''} · {formatDateTime(p.createdAt)}
        </span>
        <a
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/10"
        >
          <ExternalLink className="size-4" aria-hidden /> Abrir em nova aba
        </a>
        <button
          ref={close}
          type="button"
          aria-label="Fechar"
          className="rounded-lg p-2 hover:bg-white/10"
          onClick={onClose}
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4">
        {total > 1 && (
          <button
            type="button"
            aria-label="Foto anterior"
            className="absolute left-2 z-10 rounded-full bg-black/50 p-3 hover:bg-black/70"
            onClick={() => go(-1)}
          >
            <ChevronLeft className="size-6" aria-hidden />
          </button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={p.id}
          src={p.url}
          alt={p.caption ?? 'Foto'}
          className="max-h-full max-w-full object-contain"
          data-testid="photo-viewer-image"
        />
        {total > 1 && (
          <button
            type="button"
            aria-label="Próxima foto"
            className="absolute right-2 z-10 rounded-full bg-black/50 p-3 hover:bg-black/70"
            onClick={() => go(1)}
          >
            <ChevronRight className="size-6" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
