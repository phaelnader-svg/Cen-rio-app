'use client';

import { changePasswordSchema } from '@cenario/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Card, PageHeader } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';

export function AccountPage() {
  const me = useMe();
  const toast = useToast();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () =>
      api('/api/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
    onSuccess: () => {
      setCurrent('');
      setNew('');
      setConfirm('');
      setError(null);
      toast('ok', 'Senha alterada. Suas outras sessões no painel foram encerradas.');
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = changePasswordSchema.safeParse({ currentPassword, newPassword });
    const map: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
    if (newPassword !== confirm) map.confirm = 'As senhas não coincidem.';
    setErrors(map);
    if (Object.keys(map).length === 0) m.mutate();
  }

  return (
    <>
      <PageHeader title="Minha conta" description={me.data?.user.email ?? undefined} />
      <Card className="max-w-lg p-6">
        <h2 className="mb-4 font-semibold">Alterar senha</h2>
        {error && (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        )}
        <form className="space-y-4" onSubmit={submit} noValidate>
          <Field label="Senha atual" error={errors.currentPassword}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrent(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Nova senha"
            error={errors.newPassword}
            hint="Mínimo de 10 caracteres, com letras e números."
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNew(e.target.value)}
              />
            )}
          </Field>
          <Field label="Confirmar nova senha" error={errors.confirm}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={m.isPending}>
            Alterar senha
          </Button>
        </form>
      </Card>
    </>
  );
}
