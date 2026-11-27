import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setTranscriber } from '../src/modules/game/owner-voice';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';

/**
 * Voz da Conversar (2026-11-26): o app grava enquanto o dono segura o botão e manda WAV 16 kHz
 * mono; o servidor transcreve (Google, trocado aqui por um roteiro) e devolve só o texto.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});
afterEach(() => setTranscriber(null));

function wav(seconds: number, rate = 16000, channels = 1) {
  const data = Buffer.alloc(rate * 2 * channels * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2 * channels, 28);
  h.writeUInt16LE(2 * channels, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString('base64');
}

describe('Voz da Conversar', () => {
  it('sem a chave no servidor: avisa que não está ligada (o app usa a voz do navegador)', async () => {
    const admin = await loginAdmin(app);
    const g = await admin.req('GET', '/api/v1/office/voice');
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ available: false });
    const r = await admin.req(
      'POST',
      '/api/v1/office/voice',
      { audio: wav(1) },
      {
        'idempotency-key': idemKey(),
      },
    );
    expect(r.status).toBe(409);
  });

  it('segurou e falou: devolve o texto; o áudio vai sem o cabeçalho', async () => {
    const admin = await loginAdmin(app);
    let got = 0;
    setTranscriber(async (b) => {
      got = b.length;
      return 'tem retirada amanhã';
    });
    expect((await admin.req('GET', '/api/v1/office/voice')).body).toEqual({ available: true });
    const r = await admin.req(
      'POST',
      '/api/v1/office/voice',
      { audio: wav(2) },
      {
        'idempotency-key': idemKey(),
      },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ text: 'tem retirada amanhã' });
    expect(got).toBe(44 + 16000 * 2 * 2);
  });

  it('formato errado (estéreo, 44 kHz) é recusado sem chamar o Google', async () => {
    const admin = await loginAdmin(app);
    let called = false;
    setTranscriber(async () => {
      called = true;
      return 'x';
    });
    for (const audio of [wav(1, 44100), wav(1, 16000, 2)]) {
      const r = await admin.req(
        'POST',
        '/api/v1/office/voice',
        { audio },
        {
          'idempotency-key': idemKey(),
        },
      );
      expect(r.status).toBe(422);
    }
    expect(called).toBe(false);
  });
});
