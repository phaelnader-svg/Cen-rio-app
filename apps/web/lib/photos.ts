'use client';

import type { AttachmentDto, AttachmentEntity } from '@cenario/shared';
import { api } from './api';

/**
 * Reformulação, Fase 2 — envio de fotos.
 *
 * Antes de enviar, a foto é reduzida NO NAVEGADOR (lado maior até {@link MAX_SIDE} px, JPEG
 * 0,85): foto de celular (12–48 MP, 4–15 MB) passa a caber no limite do servidor e sobe rápido
 * no tablet. O servidor trata de novo de qualquer forma (orientação, remoção de EXIF/GPS,
 * miniatura): esta etapa é otimização, não segurança. Se o navegador não conseguir (formato
 * desconhecido, memória), o arquivo original segue e o servidor decide.
 */
const MAX_SIDE = 2560;
/** Abaixo disso (e já dentro do tamanho), não vale reprocessar. */
const SMALL_BYTES = 1_500_000;

export async function preparePhoto(file: File): Promise<File> {
  if (typeof window === 'undefined' || typeof createImageBitmap === 'undefined') return file;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.type))
    return file;
  try {
    // "from-image": aplica a orientação EXIF ao desenhar (a foto já sai em pé).
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SMALL_BYTES && file.type !== 'image/heic') {
      bitmap.close();
      return file;
    }
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    // PNG com transparência fica PNG; o resto vira JPEG (sem metadados: o canvas não os copia).
    const keepPng = file.type === 'image/png' && file.size <= SMALL_BYTES * 2;
    const type = keepPng ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, 0.85));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + (keepPng ? '.png' : '.jpg');
    return new File([blob], name, { type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/** Envia UMA foto (já preparada) como anexo de um registro. */
export async function uploadPhoto(input: {
  entityType: AttachmentEntity;
  entityId: string;
  file: File;
  caption?: string;
}): Promise<AttachmentDto> {
  const fd = new FormData();
  fd.append('entityType', input.entityType);
  fd.append('entityId', input.entityId);
  if (input.caption) fd.append('caption', input.caption);
  fd.append('file', await preparePhoto(input.file));
  return api<AttachmentDto>('/api/v1/attachments', { method: 'POST', body: fd });
}
