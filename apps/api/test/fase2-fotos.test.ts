import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { sha256Hex } from '../src/lib/crypto';
import { type Client, createTestApp, db, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { panelUserWith } from './commercial-helpers';

/**
 * Reformulação, Fase 2 — tratamento seguro de fotos (banco e armazenamento descartáveis).
 * Fotos novas: orientadas, SEM metadados (EXIF/GPS), reduzidas e com miniatura; o original não é
 * guardado. Fotos antigas: o arquivo gravado nunca é reescrito, mas a rota comum as entrega sem
 * metadados. Permissões e auditoria do fluxo atual preservadas.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
});

/** Foto "de celular": 4000 × 3000, EXIF com orientação 6 (girar 90°) e coordenadas GPS. */
async function phonePhoto(format: 'jpeg' | 'png' | 'webp' = 'jpeg', w = 4000, h = 3000) {
  const base = sharp({
    create: { width: w, height: h, channels: 3, background: { r: 180, g: 120, b: 60 } },
  })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: 'CelularTeste', Model: 'X1', Software: 'Camera' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '23/1 33/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '46/1 38/1 0/1',
      },
    });
  return (
    format === 'png' ? base.png() : format === 'webp' ? base.webp() : base.jpeg({ quality: 90 })
  ).toBuffer();
}

async function upload(
  client: Client,
  entityType: string,
  entityId: string,
  file: Buffer,
  filename = 'IMG_0001.jpg',
) {
  const boundary = '----fase2';
  const part = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const payload = Buffer.concat([
    Buffer.from(part('entityType', entityType) + part('entityId', entityId)),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/v1/attachments',
    headers: {
      origin: 'http://localhost:3000',
      cookie: client.cookieHeader,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function fetchRaw(client: Client, url: string) {
  const res = await app.app.inject({
    method: 'GET',
    url,
    headers: { origin: 'http://localhost:3000', cookie: client.cookieHeader },
  });
  return { status: res.statusCode, body: res.rawPayload, headers: res.headers };
}

async function stored(key: string) {
  const { stream } = await app.ctx.storage.read(key);
  const parts: Buffer[] = [];
  for await (const c of stream as Readable) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

async function hasSensitiveMetadata(buf: Buffer) {
  const m = await sharp(buf).metadata();
  return {
    exif: Boolean(m.exif?.length),
    xmp: Boolean(m.xmp?.length),
    iptc: Boolean(m.iptc?.length),
    orientation: m.orientation ?? null,
    width: m.width,
    height: m.height,
    format: m.format,
  };
}

describe('Fotos novas: tratadas no envio', () => {
  it('foto de celular: orientada, SEM EXIF/GPS, reduzida a 2560 px, miniatura WebP; original não guardado', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Foto');
    const original = await phonePhoto('jpeg');
    // Prova de que a entrada realmente tem GPS e orientação.
    const before = await sharp(original).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif?.includes(Buffer.from('CelularTeste'))).toBe(true);

    const r = await upload(admin, 'SERVICE_ORDER', so.id, original);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // 4000×3000 girado 90° = 3000×4000 → cabe em 2560: 1920×2560.
    expect(r.body).toMatchObject({ width: 1920, height: 2560, mimeType: 'image/jpeg' });
    expect(r.body.thumbUrl).toBe(`${r.body.url}/miniatura`);

    const file = await db().storedFile.findUniqueOrThrow({
      where: { id: r.body.url.split('/').pop() },
    });
    expect(file).toMatchObject({ width: 1920, height: 2560, originalSizeBytes: original.length });
    expect(file.processedAt).not.toBeNull();
    // O que está no armazenamento é a versão tratada (o original com GPS não existe em lugar algum).
    const saved = await stored(file.storageKey);
    expect(sha256Hex(saved)).toBe(file.sha256);
    expect(saved.length).toBe(file.sizeBytes);
    expect(saved.length).toBeLessThan(original.length);
    expect(saved.includes(Buffer.from('CelularTeste'))).toBe(false);
    expect(await hasSensitiveMetadata(saved)).toMatchObject({
      exif: false,
      xmp: false,
      iptc: false,
      orientation: null,
      width: 1920,
      height: 2560,
      format: 'jpeg',
    });
    // Miniatura própria, também sem metadados.
    const thumb = await stored(file.thumbKey!);
    expect(thumb.length).toBe(file.thumbSizeBytes);
    expect(await hasSensitiveMetadata(thumb)).toMatchObject({
      exif: false,
      width: 360,
      height: 480,
      format: 'webp',
    });

    // Leitura pela rota comum e pela miniatura: mesmos bytes tratados.
    const full = await fetchRaw(admin, r.body.url);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('image/jpeg');
    expect(sha256Hex(full.body)).toBe(file.sha256);
    const mini = await fetchRaw(admin, r.body.thumbUrl);
    expect(mini.status).toBe(200);
    expect(mini.headers['content-type']).toBe('image/webp');
    expect(mini.body.equals(thumb)).toBe(true);

    // A lista devolve miniatura e dimensões.
    const list = await admin.get(`/api/v1/attachments?entityType=SERVICE_ORDER&entityId=${so.id}`);
    expect(list.body[0]).toMatchObject({ width: 1920, height: 2560, thumbUrl: r.body.thumbUrl });
    // Auditoria do fluxo atual preservada.
    expect(
      await db().auditLog.count({ where: { action: 'attachment.added', entityId: so.id } }),
    ).toBe(1);
  });

  it('PNG continua PNG e WebP continua WebP, ambos sem metadados; foto pequena não é ampliada', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Formatos');
    const png = await upload(
      admin,
      'SERVICE_ORDER',
      so.id,
      await phonePhoto('png', 800, 600),
      'a.png',
    );
    expect(png.status).toBe(201);
    expect(png.body).toMatchObject({ mimeType: 'image/png', width: 600, height: 800 });
    const webp = await upload(
      admin,
      'SERVICE_ORDER',
      so.id,
      await phonePhoto('webp', 640, 480),
      'b.webp',
    );
    expect(webp.status).toBe(201);
    expect(webp.body).toMatchObject({ mimeType: 'image/webp', width: 480, height: 640 });
    for (const r of [png, webp]) {
      const f = await db().storedFile.findUniqueOrThrow({
        where: { id: r.body.url.split('/').pop() },
      });
      expect((await hasSensitiveMetadata(await stored(f.storageKey))).exif).toBe(false);
    }
  });

  it('arquivo inválido ou corrompido é recusado (415) e nada é gravado; imagem gigante é recusada (413)', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Inválido');
    const before = await db().storedFile.count();
    // Cabeçalho JPEG verdadeiro com o resto corrompido.
    const good = await phonePhoto('jpeg', 400, 300);
    const corrupt = Buffer.concat([good.subarray(0, 200), Buffer.alloc(400, 7)]);
    expect((await upload(admin, 'SERVICE_ORDER', so.id, corrupt)).status).toBe(415);
    // 9000 × 9000 (81 MP, acima do teto de 64 MP), arquivo pequeno (cor única).
    const huge = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: '#fff' },
    })
      .jpeg({ quality: 10 })
      .toBuffer();
    expect((await upload(admin, 'SERVICE_ORDER', so.id, huge)).status).toBe(413);
    expect(await db().storedFile.count()).toBe(before);
  });

  it('permissões inalteradas: miniatura segue a mesma política da foto; remover apaga também a miniatura', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Política');
    const r = await upload(admin, 'SERVICE_ORDER', so.id, await phonePhoto('jpeg', 800, 600));
    const outsider = await panelUserWith(app, admin, 'sem-os', ['clientes.ver']);
    expect((await fetchRaw(outsider, r.body.url)).status).toBe(403);
    expect((await fetchRaw(outsider, r.body.thumbUrl)).status).toBe(403);
    const file = await db().storedFile.findUniqueOrThrow({
      where: { id: r.body.url.split('/').pop() },
    });
    const del = await app.app.inject({
      method: 'DELETE',
      url: `/api/v1/attachments/${r.body.id}`,
      headers: { origin: 'http://localhost:3000', cookie: admin.cookieHeader },
    });
    expect(del.statusCode).toBe(204);
    await expect(app.ctx.storage.read(file.thumbKey!)).rejects.toThrow();
    expect((await fetchRaw(admin, r.body.thumbUrl)).status).toBe(404);
  });

  it('foto de funcionário também sai sem metadados e limitada a 1024 px', async () => {
    const admin = await loginAdmin(app);
    const emp = await db().employee.findFirstOrThrow({ where: { displayName: 'Ricardo' } });
    const boundary = '----func';
    const res = await app.app.inject({
      method: 'POST',
      url: `/api/employees/${emp.id}/photo`,
      headers: {
        origin: 'http://localhost:3000',
        cookie: admin.cookieHeader,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
        ),
        await phonePhoto('jpeg'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await db().employee.findUniqueOrThrow({
      where: { id: emp.id },
      include: { photo: true },
    });
    expect(after.photo).toMatchObject({ width: 768, height: 1024 });
    const saved = await stored(after.photo!.storageKey);
    expect(await hasSensitiveMetadata(saved)).toMatchObject({
      exif: false,
      width: 768,
      height: 1024,
    });
  });
});

describe('Fotos antigas (anteriores à Fase 2): original intacto, leitura sem metadados', () => {
  /** Simula uma foto gravada antes da Fase 2: bytes originais com EXIF/GPS, sem tratamento. */
  async function legacyPhoto(admin: Client) {
    const so = await openServiceOrder(admin, 'Cliente Legado');
    const original = await phonePhoto('jpeg', 1200, 900);
    const fileId = randomUUID();
    const storageKey = `attachment/${fileId}`;
    await app.ctx.storage.put(storageKey, original);
    const me = await db().user.findUniqueOrThrow({ where: { email: 'gestor@teste.local' } });
    await db().storedFile.create({
      data: {
        id: fileId,
        storageKey,
        purpose: 'attachment',
        originalName: 'antiga.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: original.length,
        sha256: sha256Hex(original),
        uploadedById: me.id,
      },
    });
    await db().attachment.create({
      data: { fileId, entityType: 'SERVICE_ORDER', entityId: so.id, createdById: me.id },
    });
    return { so, fileId, storageKey, original };
  }

  it('a rota comum entrega a foto antiga orientada e SEM EXIF/GPS, e o arquivo original não muda', async () => {
    const admin = await loginAdmin(app);
    const { fileId, storageKey, original } = await legacyPhoto(admin);
    const got = await fetchRaw(admin, `/api/files/${fileId}`);
    expect(got.status).toBe(200);
    expect(got.body.includes(Buffer.from('CelularTeste'))).toBe(false);
    expect(await hasSensitiveMetadata(got.body)).toMatchObject({
      exif: false,
      orientation: null,
      width: 900,
      height: 1200,
    });
    const mini = await fetchRaw(admin, `/api/files/${fileId}/miniatura`);
    expect(mini.status).toBe(200);
    expect(await hasSensitiveMetadata(mini.body)).toMatchObject({ exif: false, format: 'webp' });
    // Original intacto no armazenamento e no banco (nada foi reescrito).
    expect((await stored(storageKey)).equals(original)).toBe(true);
    const row = await db().storedFile.findUniqueOrThrow({ where: { id: fileId } });
    expect(row).toMatchObject({ processedAt: null, thumbKey: null, sha256: sha256Hex(original) });
  });
});
