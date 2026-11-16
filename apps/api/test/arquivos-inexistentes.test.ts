import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { panelUserWith } from './commercial-helpers';
import { Client, createTestApp, db, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { uploadPhoto } from './production-helpers';

/**
 * Homologação funcional F′ — B3: registro de foto cujo arquivo físico sumiu respondia 500. Agora:
 * original ausente → 404 na foto e na miniatura; miniatura salva ausente com original presente →
 * miniatura regenerada da original (200). Autenticação (401) e autorização (403) continuam
 * verificadas ANTES (não revelam se o arquivo existe). O registro não é alterado.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());

async function fotoNaOs() {
  const admin = await loginAdmin(app);
  const so = await openServiceOrder(admin, 'HML-Cliente Arquivo');
  const up = await uploadPhoto(app, admin, 'SERVICE_ORDER', so.id);
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const fileId = (up.body.url as string).split('/').pop()!;
  return { admin, so, fileId };
}

describe('Arquivo inexistente (B3)', () => {
  it('miniatura salva ausente: gera da original (200)', async () => {
    const { admin, fileId } = await fotoNaOs();
    await app.ctx.storage.remove(`attachment-thumb/${fileId}`);
    const r = await app.app.inject({
      method: 'GET',
      url: `/api/files/${fileId}/miniatura`,
      headers: { cookie: admin.cookieHeader, origin: 'http://localhost:3000' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/webp');
    expect(r.rawPayload.length).toBeGreaterThan(0);
  });

  it('original ausente: 404 na foto e na miniatura, sem alterar o registro', async () => {
    const { admin, fileId } = await fotoNaOs();
    const antes = await db().storedFile.findUniqueOrThrow({ where: { id: fileId } });
    await app.ctx.storage.remove(`attachment/${fileId}`);
    await app.ctx.storage.remove(`attachment-thumb/${fileId}`);
    for (const url of [`/api/files/${fileId}`, `/api/files/${fileId}/miniatura`]) {
      const r = await admin.get(url);
      expect(r.status, url).toBe(404);
      expect(r.body.error.code, url).toBe('NOT_FOUND');
      expect(r.body.error.message, url).toBe('Arquivo não encontrado.');
    }
    expect(await db().storedFile.findUniqueOrThrow({ where: { id: fileId } })).toEqual(antes);
  });

  it('sem sessão: 401; sem permissão: 403 — antes de olhar o arquivo', async () => {
    const { admin, fileId } = await fotoNaOs();
    await app.ctx.storage.remove(`attachment/${fileId}`);
    await app.ctx.storage.remove(`attachment-thumb/${fileId}`);
    const anon = new Client(app);
    for (const url of [`/api/files/${fileId}`, `/api/files/${fileId}/miniatura`])
      expect((await anon.get(url)).status, url).toBe(401);
    const semPermissao = await panelUserWith(app, admin, 'hmlsemfoto', ['clientes.ver']);
    for (const url of [`/api/files/${fileId}`, `/api/files/${fileId}/miniatura`])
      expect((await semPermissao.get(url)).status, url).toBe(403);
  });

  it('foto removida pela galeria continua 404 (comportamento anterior preservado)', async () => {
    const { admin, fileId } = await fotoNaOs();
    const lista = await admin.get(
      `/api/v1/attachments?entityType=SERVICE_ORDER&entityId=${(await db().attachment.findFirstOrThrow({ where: { fileId } })).entityId}`,
    );
    const id = (lista.body as { id: string }[])[0]!.id;
    const del = await admin.req('DELETE', `/api/v1/attachments/${id}`, undefined, {});
    expect(del.status).toBe(204);
    expect((await admin.get(`/api/files/${fileId}`)).status).toBe(404);
  });
});
