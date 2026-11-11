import sharp, { type Sharp } from 'sharp';
import { Errors } from '../../lib/errors';

/**
 * Reformulação, Fase 2 — tratamento seguro de fotos.
 *
 * Toda foto NOVA é reprocessada no servidor antes de ser gravada:
 *  - orientação aplicada (EXIF Orientation) e depois descartada — a foto fica "em pé" em qualquer
 *    visualizador, sem depender do metadado;
 *  - TODOS os metadados removidos (EXIF, GPS, XMP, IPTC, comentários): o `sharp` só os copia
 *    quando pedido explicitamente, e aqui nunca pedimos;
 *  - lado maior limitado a {@link MAX_SIDE} px (qualidade suficiente para avaliar o serviço, sem
 *    guardar os 12–48 MP do celular), com recompressão no mesmo formato;
 *  - miniatura WebP de {@link THUMB_SIDE} px para as galerias.
 * O original NÃO é guardado (é ele que carrega o GPS).
 *
 * Fotos ANTIGAS (gravadas antes desta fase) não são reescritas: ao serem lidas pela rota comum,
 * saem sem metadados (ver {@link sanitizeLegacy}); o arquivo original continua intacto no
 * armazenamento até uma migração em lotes autorizada.
 */
export const MAX_SIDE = 2560;
export const THUMB_SIDE = 480;
/** Teto de pixels de entrada (≈ 8000 × 8000): protege a VM contra "bombas" de descompressão. */
const MAX_INPUT_PIXELS = 64_000_000;

// VM pequena: uma imagem por vez e sem cache de operações em memória.
sharp.concurrency(1);
sharp.cache(false);

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ProcessedImage {
  data: Buffer;
  mime: ImageMime;
  width: number;
  height: number;
  thumb: Buffer;
  thumbMime: 'image/webp';
}

const open = (input: Buffer) =>
  sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS });

function encode(img: Sharp, mime: ImageMime, quality: number) {
  if (mime === 'image/png') return img.png({ compressionLevel: 9, adaptiveFiltering: true });
  if (mime === 'image/webp') return img.webp({ quality });
  return img.jpeg({ quality, mozjpeg: true });
}

/** Foto nova: orientação, sem metadados, tamanho limitado e miniatura. */
export async function processImage(
  input: Buffer,
  mime: ImageMime,
  maxSide = MAX_SIDE,
): Promise<ProcessedImage> {
  try {
    const { data, info } = await encode(
      open(input).rotate().resize({
        width: maxSide,
        height: maxSide,
        fit: 'inside',
        withoutEnlargement: true,
      }),
      mime,
      82,
    ).toBuffer({ resolveWithObject: true });
    const thumb = await thumbnail(data);
    return { data, mime, width: info.width, height: info.height, thumb, thumbMime: 'image/webp' };
  } catch (error) {
    if ((error as Error).message?.includes('pixel limit'))
      throw Errors.payloadTooLarge('A imagem tem resolução grande demais.');
    throw Errors.unsupportedMedia('Não foi possível ler a imagem (arquivo inválido ou corrompido).');
  }
}

/** Miniatura WebP (sem metadados) a partir de qualquer imagem suportada. */
export async function thumbnail(input: Buffer): Promise<Buffer> {
  return open(input)
    .rotate()
    .resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
}

/**
 * Foto ANTIGA lida pela rota comum: devolvida sem metadados (EXIF/GPS) e já orientada, no mesmo
 * formato e sem reduzir. Não grava nada — o arquivo original fica como está.
 */
export async function sanitizeLegacy(input: Buffer, mime: ImageMime): Promise<Buffer> {
  return encode(open(input).rotate(), mime, 90).toBuffer();
}

/** O arquivo traz algum metadado EXIF/XMP/IPTC? (para o diagnóstico das fotos antigas). */
export async function metadataReport(input: Buffer) {
  const m = await open(input).metadata();
  return {
    exif: Boolean(m.exif?.length),
    xmp: Boolean(m.xmp?.length),
    iptc: Boolean(m.iptc?.length),
    // O bloco EXIF guarda o GPS na etiqueta 0x8825 (TIFF em qualquer ordem de bytes); a presença
    // da etiqueta basta para o diagnóstico.
    gps: Boolean(
      m.exif &&
        (m.exif.includes(Buffer.from([0x25, 0x88])) || m.exif.includes(Buffer.from([0x88, 0x25]))),
    ),
    orientation: m.orientation ?? null,
    width: m.width ?? null,
    height: m.height ?? null,
  };
}
