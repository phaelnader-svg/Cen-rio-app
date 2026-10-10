'use client';

import type { AttachmentEntity } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useAttachments } from '@/lib/commercial';

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
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const fd = new FormData();
        fd.append('entityType', entityType);
        fd.append('entityId', entityId);
        if (caption) fd.append('caption', caption);
        fd.append('file', file);
        await api('/api/v1/attachments', { method: 'POST', body: fd });
      }
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
          {photos.data.map((p) => (
            <li
              key={p.id}
              className="group relative overflow-hidden rounded-xl border border-line bg-subtle"
            >
              <a href={p.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={p.caption ?? 'Foto'}
                  className="aspect-square w-full object-cover"
                />
              </a>
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
