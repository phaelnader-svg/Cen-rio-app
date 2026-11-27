'use client';

import type { AttachmentEntity } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

const MAX_SECONDS = 300;

/**
 * Melhoria 117: recado por áudio no tablet (para quem tem as mãos ocupadas ou não gosta de
 * digitar). Grava, envia e o gestor ouve na tarefa, no painel.
 */
export function AudioNote({
  entityType,
  entityId,
}: {
  entityType: AttachmentEntity;
  entityId: string;
}) {
  const qc = useQueryClient();
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => {
    if (recording && seconds >= MAX_SECONDS) rec.current?.stop();
  }, [recording, seconds]);
  useEffect(() => () => rec.current?.stream.getTracks().forEach((t) => t.stop()), []);

  async function start() {
    setError(null);
    setSent(false);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) {
      setError('Este aparelho não grava áudio pelo navegador.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        void send(new Blob(chunks.current, { type: r.mimeType }));
      };
      rec.current = r;
      r.start();
      setSeconds(0);
      setRecording(true);
    } catch {
      setError('Não foi possível usar o microfone. Libere o acesso ao microfone e tente de novo.');
    }
  }

  async function send(blob: Blob) {
    if (blob.size < 1000) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append('entityType', entityType);
      fd.append('entityId', entityId);
      fd.append('file', blob, 'recado');
      await api('/api/v1/attachments/audio', { method: 'POST', body: fd });
      setSent(true);
      await qc.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div className="space-y-3">
      {recording ? (
        <Button
          size="lg"
          variant="danger"
          className="w-full"
          icon={<Square className="size-5" aria-hidden />}
          onClick={() => rec.current?.stop()}
        >
          Parar e enviar ({mmss})
        </Button>
      ) : (
        <Button
          size="lg"
          variant="secondary"
          className="w-full"
          loading={sending}
          icon={<Mic className="size-5" aria-hidden />}
          onClick={() => void start()}
          data-testid="gravar-recado"
        >
          {sending ? 'Enviando…' : 'Gravar recado por áudio'}
        </Button>
      )}
      {sent && <Alert tone="ok">Recado enviado. O gestor ouve na tarefa.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
