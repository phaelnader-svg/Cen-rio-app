'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { hasWhatsapp, type MeDto } from '@cenario/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { typedWhatsapp } from '@/lib/format';

/**
 * Boas-vindas do primeiro acesso de uma empresa criada pelo Criar conta: troca o nome provisório
 * ("Minha empresa") pelo nome real e o nome do gestor (que nasce do começo do e-mail).
 *
 * 26/11/2026: toda empresa sem telefone (celular com DDD) informa o número ao entrar, antes de
 * mexer no sistema, inclusive as contas novas (o cadastro não pede). É obrigatório: o dono da
 * plataforma precisa ter como falar com cada empresa.
 */
export function WelcomeDialog({ me }: { me: MeDto }) {
  const qc = useQueryClient();
  const [later, setLater] = useState(false);
  const [tradeName, setTradeName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const welcome = me.company.needsWelcome && !later;
  const askWhatsapp = me.company.needsWhatsapp;
  if (!welcome && !askWhatsapp) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (welcome) {
        await api('/api/company/welcome', {
          method: 'POST',
          body: { tradeName, displayName, ...(askWhatsapp ? { whatsapp } : {}) },
        });
      } else {
        await api('/api/company/contact', { method: 'POST', body: { whatsapp } });
      }
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  const digits = whatsapp.replace(/\D/g, '');
  const phoneError =
    digits.length >= 10 && !hasWhatsapp(whatsapp)
      ? 'Escreva o celular com DDD e 9 números. Ex.: (11) 98765-4321.'
      : undefined;
  const ready =
    (!welcome || (tradeName.trim().length >= 2 && displayName.trim().length >= 2)) &&
    (!askWhatsapp || hasWhatsapp(whatsapp));

  return (
    <Dialog
      open
      dismissible={!askWhatsapp}
      onClose={() => setLater(true)}
      title={welcome ? 'Boas-vindas ao Cenário Gestão' : 'Qual é o seu telefone?'}
      description={
        welcome
          ? 'Antes de começar, conte como se chama a sua empresa e como você quer ser chamado. Dá para mudar depois na tela Empresa.'
          : 'Antes de começar, deixe um telefone com DDD. Ele só é usado para assuntos da sua conta.'
      }
    >
      <form onSubmit={save} className="space-y-4" data-testid="welcome-form">
        {welcome && (
          <>
            <Field label="Nome da empresa" required>
              {(p) => (
                <Input
                  {...p}
                  value={tradeName}
                  onChange={(e) => setTradeName(e.target.value)}
                  placeholder="Ex.: Tapeçaria Silva"
                  maxLength={120}
                  autoFocus
                  required
                />
              )}
            </Field>
            <Field label="Seu nome" required>
              {(p) => (
                <Input
                  {...p}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Como aparece no painel e para a equipe"
                  maxLength={40}
                  required
                />
              )}
            </Field>
          </>
        )}
        {askWhatsapp && (
          <Field label="Telefone" required hint="Celular com DDD." error={phoneError}>
            {(p) => (
              <Input
                {...p}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                value={whatsapp}
                onChange={(e) => setWhatsapp(typedWhatsapp(e.target.value))}
                placeholder="(11) 98765-4321"
                autoFocus={!welcome}
                required
                data-testid="welcome-whatsapp"
              />
            )}
          </Field>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          {!askWhatsapp && (
            <Button type="button" variant="ghost" onClick={() => setLater(true)}>
              Depois
            </Button>
          )}
          <Button type="submit" disabled={saving || !ready}>
            {welcome ? 'Começar' : 'Confirmar'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
