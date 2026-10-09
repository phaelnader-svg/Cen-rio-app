import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Armazenamento privado de arquivos. A implementação local grava fora de
 * qualquer diretório público; o acesso acontece apenas pela rota autenticada
 * `/api/files/:id`, que aplica a política de acesso. A interface permite trocar
 * por armazenamento de objetos (S3 compatível) sem alterar os módulos.
 */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<{ stream: Readable; size: number }>;
  remove(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9-]+\/[0-9a-f-]{36}$/;

export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('Chave de armazenamento inválida');
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('Caminho fora do armazenamento');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  }

  async read(key: string): Promise<{ stream: Readable; size: number }> {
    const path = this.pathFor(key);
    const info = await stat(path);
    return { stream: createReadStream(path), size: info.size };
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

/** Detecta o tipo real de imagem pelos bytes iniciais (não confia no nome nem no cabeçalho). */
export function sniffImageType(data: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
