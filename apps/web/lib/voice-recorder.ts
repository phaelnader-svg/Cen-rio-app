/**
 * Gravação da voz da Conversar (2026-11-26): grava enquanto o dono segura o botão e entrega WAV
 * 16 kHz mono em base64, o formato que o servidor manda ao Google. Funciona no app instalado no
 * iPhone (MediaRecorder + microfone), onde a voz do navegador não funciona.
 */
export function canRecord(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export interface Recording {
  /** Para de gravar e devolve o WAV em base64 (ou null se não gravou nada). */
  stop: () => Promise<string | null>;
  /** Para e joga fora. */
  cancel: () => void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    cancel: () => {
      try {
        rec.stop();
      } catch {
        /* já parado */
      }
      release();
    },
    stop: () =>
      new Promise((resolve, reject) => {
        rec.onstop = async () => {
          release();
          try {
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/mp4' });
            resolve(blob.size ? await toWav16k(blob) : null);
          } catch (e) {
            reject(e);
          }
        };
        rec.stop();
      }),
  };
}

const RATE = 16000;

async function toWav16k(blob: Blob): Promise<string> {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void ctx.close();
  }
  // Até 59 s (o servidor aceita 60): mistura os canais e reamostra para 16 kHz.
  const length = Math.min(Math.ceil(decoded.duration * RATE), RATE * 59);
  const off = new OfflineAudioContext(1, Math.max(length, 1), RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = (await off.startRendering()).getChannelData(0);
  const bytes = new Uint8Array(44 + out.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + out.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, out.length * 2, true);
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, out[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
