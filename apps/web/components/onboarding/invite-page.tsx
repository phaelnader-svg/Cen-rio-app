'use client';

import { acceptInviteSchema, type PublicInviteDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { Camera, Check } from 'lucide-react';
import { useRef, useState } from 'react';
import { AuthCard } from '@/components/account/auth-card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { preparePhoto } from '@/lib/photos';

/**
 * Item 4 (26/11/2026): o funcionário abre o link no celular, coloca a foto e cria o PIN de 6
 * números que vai usar no tablet. Sem conta, sem e-mail, sem senha comprida.
 */
export function InvitePage({ token }: { token: string }) {
  const path = `/api/public/convite/${encodeURIComponent(token)}`;
  const info = useQuery({
    queryKey: ['convite', token],
    queryFn: () => api<PublicInviteDto>(path),
    retry: false,
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const ready = await preparePhoto(file);
      const form = new FormData();
      form.append('file', ready);
      await api(`${path}/foto`, { method: 'POST', body: form });
      setPreview(URL.createObjectURL(ready));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pin !== pin2) {
      setError('Os dois PINs não são iguais. Digite de novo.');
      return;
    }
    const parsed = acceptInviteSchema.safeParse({ pin });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'PIN inválido.');
      return;
    }
    setSaving(true);
    try {
      await api(path, { method: 'POST', body: parsed.data });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (info.isPending) {
    return (
      <AuthCard title="Terminar o cadastro">
        <div className="mt-6">
          <Spinner />
        </div>
      </AuthCard>
    );
  }
  if (info.isError || !info.data.valid) {
    return (
      <AuthCard title="Link vencido">
        <Alert tone="warn" className="mt-6" data-testid="invite-invalid">
          Este link já foi usado ou passou de 7 dias. Peça um link novo para quem cuida da equipe.
        </Alert>
      </AuthCard>
    );
  }
  const d = info.data;
  const first = d.employeeName.split(/\s+/)[0];

  if (done) {
    return (
      <AuthCard title={`Pronto, ${first}!`}>
        <Alert tone="ok" className="mt-6" data-testid="invite-done">
          Cadastro feito. No tablet da {d.companyName}, toque na sua foto e digite o seu PIN.
        </Alert>
      </AuthCard>
    );
  }

  const hasPhoto = d.hasPhoto || preview !== null;
  return (
    <AuthCard title={`Oi, ${first}!`}>
      <p className="mt-2 text-[15px] text-ink-muted">
        A {d.companyName} cadastrou você como {d.jobTitle.toLowerCase()}. Falta só a sua foto e o
        seu PIN do tablet.
      </p>
      <form onSubmit={finish} noValidate className="mt-6 space-y-5" data-testid="invite-form">
        {error && <Alert tone="danger">{error}</Alert>}
        <div>
          <p className="label">1. A sua foto</p>
          <div className="mt-2 flex items-center gap-4">
            <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-subtle">
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="" className="size-full object-cover" />
              ) : hasPhoto ? (
                <Check className="size-7 text-ok-600" aria-hidden />
              ) : (
                <Camera className="size-7 text-ink-muted" aria-hidden />
              )}
            </div>
            <div>
              <Button
                type="button"
                variant="secondary"
                loading={uploading}
                onClick={() => fileRef.current?.click()}
                data-testid="invite-photo"
              >
                {hasPhoto ? 'Trocar a foto' : 'Tirar ou escolher a foto'}
              </Button>
              <p className="mt-1 text-sm text-ink-muted">
                É a foto que aparece no tablet para você entrar.
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="user"
              className="hidden"
              onChange={(e) => void pickPhoto(e.target.files?.[0])}
            />
          </div>
        </div>
        <Field label="2. Crie o seu PIN" hint="6 números que só você sabe. Evite 123456 ou 111111.">
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              autoComplete="new-password"
              type="password"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              data-testid="invite-pin"
            />
          )}
        </Field>
        <Field label="Digite o PIN de novo">
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              autoComplete="new-password"
              type="password"
              maxLength={6}
              value={pin2}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
              data-testid="invite-pin2"
            />
          )}
        </Field>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={saving}
          disabled={pin.length !== 6 || pin2.length !== 6}
          data-testid="invite-finish"
        >
          Terminar o cadastro
        </Button>
      </form>
    </AuthCard>
  );
}
