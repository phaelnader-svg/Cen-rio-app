/**
 * Voz da Conversar (2026-11-26, pedido do Raphael: "segurar para falar" no app do iPhone).
 * No app instalado no iPhone a voz do navegador (SpeechRecognition) não funciona; o app grava o
 * áudio enquanto o dono segura o botão, converte para WAV 16 kHz mono e manda para cá. Aqui o
 * Google Speech-to-Text transcreve (chave em SPEECH_API_KEY, guardada por infra/voz/ligar-voz.sh).
 * O áudio não é guardado: vai ao Google e volta só o texto.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Errors } from '../../lib/errors';
import { OFFICE_ACCESS, officeGuard } from './office';

/** Transcreve WAV 16 kHz mono (LINEAR16). Trocável nos testes. */
export type Transcriber = (wav: Buffer) => Promise<string>;

const googleTranscriber =
  (key: string, base: string): Transcriber =>
  async (wav) => {
    const r = await fetch(`${base}/v1/speech:recognize?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: 'pt-BR',
          enableAutomaticPunctuation: true,
        },
        // O cabeçalho WAV (44 bytes) fica de fora: o Google quer só as amostras.
        audio: { content: wav.subarray(44).toString('base64') },
      }),
    });
    if (!r.ok) throw new Error(`speech ${r.status}`);
    const j = (await r.json()) as {
      results?: { alternatives?: { transcript?: string }[] }[];
    };
    return (j.results ?? [])
      .map((x) => x.alternatives?.[0]?.transcript ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

let override: Transcriber | null = null;
export function setTranscriber(t: Transcriber | null) {
  override = t;
}

/** Até 60 s de fala (limite do reconhecimento direto do Google): 16000 × 2 bytes × 60 + cabeçalho. */
const MAX_WAV = 16000 * 2 * 60 + 44;
const bodySchema = z.object({
  audio: z
    .string()
    .min(100)
    .max(Math.ceil((MAX_WAV * 4) / 3) + 8),
});

function isWav16kMono(b: Buffer) {
  return (
    b.length > 44 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WAVE' &&
    b.readUInt16LE(20) === 1 && // PCM
    b.readUInt16LE(22) === 1 && // mono
    b.readUInt32LE(24) === 16000 &&
    b.readUInt16LE(34) === 16
  );
}

export async function ownerVoiceRoutes(app: FastifyInstance) {
  const { prisma, env } = app.ctx;
  const transcriber = () =>
    override ??
    (env.SPEECH_API_KEY ? googleTranscriber(env.SPEECH_API_KEY, env.SPEECH_BASE_URL) : null);

  // O app pergunta antes de gravar: sem a voz no servidor, usa a voz do navegador ou o teclado.
  app.get('/api/v1/office/voice', { config: { access: OFFICE_ACCESS } }, async () => ({
    available: !!transcriber(),
  }));

  app.post(
    '/api/v1/office/voice',
    { config: { access: OFFICE_ACCESS }, bodyLimit: 4 * 1024 * 1024 },
    async (request) => {
      await officeGuard(prisma);
      const t = transcriber();
      if (!t) throw Errors.conflict('A voz ainda não está ligada no servidor.');
      const { audio } = bodySchema.parse(request.body);
      const wav = Buffer.from(audio, 'base64');
      if (!isWav16kMono(wav) || wav.length > MAX_WAV)
        throw Errors.business('Áudio em formato errado. Segure o botão e fale de novo.');
      let text: string;
      try {
        text = await t(wav);
      } catch {
        throw Errors.business('Não deu para entender o áudio agora. Tente de novo.');
      }
      return { text };
    },
  );
}
