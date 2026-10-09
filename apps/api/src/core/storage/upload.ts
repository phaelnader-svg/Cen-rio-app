import type { FastifyRequest } from 'fastify';
import { Errors } from '../../lib/errors';
import { sniffImageType } from './storage';

export interface ImageUpload {
  data: Buffer;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  filename: string;
  fields: Record<string, string>;
}

/**
 * Lê uma imagem enviada por multipart/form-data, validando tamanho e o tipo
 * REAL pelos bytes (não confia no nome nem no Content-Type informado).
 */
export async function readImageUpload(
  request: FastifyRequest,
  maxMb: number,
): Promise<ImageUpload> {
  if (!request.isMultipart())
    throw Errors.unsupportedMedia('Envie o arquivo como multipart/form-data.');
  const file = await request.file({ limits: { fileSize: maxMb * 1024 * 1024, files: 1 } });
  if (!file) throw Errors.validation(undefined, 'Nenhum arquivo enviado.');
  const data = await file.toBuffer().catch((error: unknown) => {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw Errors.payloadTooLarge(`O arquivo deve ter no máximo ${maxMb} MB.`);
    }
    throw error;
  });
  const mime = sniffImageType(data);
  if (!mime) throw Errors.unsupportedMedia('Formato não suportado. Envie JPEG, PNG ou WebP.');
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(file.fields)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v && 'value' in v && typeof v.value === 'string') fields[key] = v.value;
  }
  return { data, mime, filename: (file.filename || 'foto').slice(0, 200), fields };
}
