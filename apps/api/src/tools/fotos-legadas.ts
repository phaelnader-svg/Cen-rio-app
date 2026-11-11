/**
 * Reformulação, Fase 2 — DIAGNÓSTICO das fotos anteriores ao tratamento (SOMENTE LEITURA).
 *
 * Uso (no contêiner da API ou localmente):
 *   DATABASE_URL=… STORAGE_DIR=… node --import tsx src/tools/fotos-legadas.ts [--lote 200]
 *
 * Não grava NADA: nem banco, nem armazenamento. Lê cada foto sem `processed_at` e informa quantas
 * têm EXIF, GPS ou orientação, o tamanho total e as que não puderam ser lidas. Serve para
 * dimensionar a migração em lotes (que depende de autorização específica: backup antes,
 * processamento em lotes, conferência de hash e nunca sobrescrever o original sem aprovação).
 */
import { createPrismaClient } from '@cenario/db';
import type { Readable } from 'node:stream';
import { metadataReport } from '../core/storage/image';
import { LocalFileStorage } from '../core/storage/storage';

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

async function main() {
  const url = process.env.DATABASE_URL;
  const dir = process.env.STORAGE_DIR;
  if (!url || !dir) throw new Error('Defina DATABASE_URL e STORAGE_DIR.');
  const idx = process.argv.indexOf('--lote');
  const lote = idx > 0 ? Math.max(1, Number(process.argv[idx + 1]) || 200) : 200;
  const prisma = createPrismaClient({ url });
  const storage = new LocalFileStorage(dir);
  const total = { fotos: 0, bytes: 0, exif: 0, gps: 0, girar: 0, ilegiveis: 0, ausentes: 0 };
  const porFinalidade: Record<string, number> = {};
  let cursor: string | undefined;
  try {
    for (;;) {
      const rows = await prisma.storedFile.findMany({
        where: { processedAt: null, deletedAt: null, mimeType: { in: IMAGE_MIMES } },
        orderBy: { id: 'asc' },
        take: lote,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;
      for (const f of rows) {
        total.fotos += 1;
        total.bytes += f.sizeBytes;
        porFinalidade[f.purpose] = (porFinalidade[f.purpose] ?? 0) + 1;
        let data: Buffer;
        try {
          const { stream } = await storage.read(f.storageKey);
          const parts: Buffer[] = [];
          for await (const c of stream as Readable) parts.push(c as Buffer);
          data = Buffer.concat(parts);
        } catch {
          total.ausentes += 1;
          continue;
        }
        try {
          const m = await metadataReport(data);
          if (m.exif || m.xmp || m.iptc) total.exif += 1;
          if (m.gps) total.gps += 1;
          if (m.orientation && m.orientation !== 1) total.girar += 1;
        } catch {
          total.ilegiveis += 1;
        }
      }
      cursor = rows[rows.length - 1]!.id;
    }
  } finally {
    await prisma.$disconnect();
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        modo: 'somente leitura (nada foi alterado)',
        ...total,
        megabytes: Math.round((total.bytes / 1048576) * 10) / 10,
        porFinalidade,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
