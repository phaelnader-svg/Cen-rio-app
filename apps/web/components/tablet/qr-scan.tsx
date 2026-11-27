'use client';

import type { MyQueueDto, ProductionTaskDto } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ScanLine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { osIdFromQr } from '@/components/improvements/os-extras';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/misc';
import { api } from '@/lib/api';

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

/**
 * Melhoria 107: "Ler etiqueta" no tablet. A câmera lê o QR colado na peça e abre a tarefa do
 * funcionário naquela O.S. Usa o leitor de códigos do próprio navegador (Chrome do Android).
 */
export function QrScanButton({ onTask }: { onTask: (taskId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        icon={<ScanLine className="size-5" aria-hidden />}
        onClick={() => setOpen(true)}
        data-testid="ler-etiqueta"
      >
        Ler etiqueta
      </Button>
      {open && (
        <ScanDialog
          onClose={() => setOpen(false)}
          onTask={(id) => {
            setOpen(false);
            onTask(id);
          }}
        />
      )}
    </>
  );
}

function ScanDialog({ onClose, onTask }: { onClose: () => void; onTask: (id: string) => void }) {
  const qc = useQueryClient();
  const video = useRef<HTMLVideoElement>(null);
  const onTaskRef = useRef(onTask);
  useEffect(() => {
    onTaskRef.current = onTask;
  }, [onTask]);
  // Leitor de QR do próprio navegador (Chrome do Android); sem ele, a tela explica.
  const [error, setError] = useState<string | null>(() =>
    (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
      ? null
      : 'Este aparelho não lê QR pelo navegador. Abra a tarefa pela lista ou use a câmera do celular.',
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Ctor) return;
    let stream: MediaStream | null = null;
    let stop = false;
    let busy = false;
    const detector = new Ctor({ formats: ['qr_code'] });
    const findTask = async (osId: string) => {
      const queue = await qc.fetchQuery({
        queryKey: ['my-queue'],
        queryFn: () => api<MyQueueDto>('/api/v1/production-tasks/mine/queue'),
      });
      const mine = await qc.fetchQuery({
        queryKey: ['my-tasks'],
        queryFn: () =>
          api<{ today: ProductionTaskDto[]; upcoming: ProductionTaskDto[] }>(
            '/api/v1/production-tasks/mine',
          ),
      });
      const tasks = [
        ...(queue.current ? [queue.current] : []),
        ...queue.items.map((i) => i.task),
        ...mine.today,
        ...mine.upcoming,
      ];
      return tasks.find((t) => t.serviceOrder.id === osId) ?? null;
    };
    const loop = async () => {
      if (stop || !video.current) return;
      if (!busy && video.current.readyState >= 2) {
        busy = true;
        try {
          const codes = await detector.detect(video.current);
          const osId = codes.map((c) => osIdFromQr(c.rawValue)).find(Boolean);
          if (codes.length && !osId) setNotice('Esta etiqueta não é do Cenário Gestão.');
          if (osId) {
            const task = await findTask(osId);
            if (task) {
              stop = true;
              onTaskRef.current(task.id);
              return;
            }
            setNotice('Você não tem tarefa nesta peça agora. Confira com o gestor.');
          }
        } catch {
          /* quadro sem leitura: tenta de novo */
        }
        busy = false;
      }
      setTimeout(() => void loop(), 300);
    };
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        stream = s;
        if (stop) return s.getTracks().forEach((t) => t.stop());
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        void loop();
      })
      .catch(() =>
        setError('Não foi possível abrir a câmera. Libere o acesso à câmera e tente de novo.'),
      );
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [qc]);

  return (
    <Dialog open onClose={onClose} title="Ler etiqueta da peça" size="md">
      {error ? (
        <Alert tone="warn">{error}</Alert>
      ) : (
        <>
          <video
            ref={video}
            muted
            playsInline
            className="aspect-[4/3] w-full rounded-xl bg-black object-cover"
          />
          <p className="mt-3 text-center text-base text-ink-soft">
            Aponte a câmera para o QR da etiqueta.
          </p>
          {notice && (
            <Alert tone="info" className="mt-3">
              {notice}
            </Alert>
          )}
        </>
      )}
    </Dialog>
  );
}
