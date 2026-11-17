'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { MeDto } from '@cenario/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api } from '@/lib/api';

/**
 * Boas-vindas do primeiro acesso de uma empresa criada pelo Criar conta: troca o nome provisório
 * ("Minha empresa") pelo nome real e o nome do gestor (que nasce do começo do e-mail).
 */
export function WelcomeDialog({ me }: { me: MeDto }) {
  const qc = useQueryClient();
  const [later, setLater] = useState(false);
  const [tradeName, setTradeName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!me.company.needsWelcome || later) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api('/api/company/welcome', {
        method: 'POST',
        body: { tradeName, displayName },
      });
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => setLater(true)}
      title="Boas-vindas ao Cenário Gestão"
      description="Antes de começar, conte como se chama a sua empresa e como você quer ser chamado. Dá para mudar depois na tela Empresa."
    >
      <form onSubmit={save} className="space-y-4" data-testid="welcome-form">
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
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setLater(true)}>
            Depois
          </Button>
          <Button
            type="submit"
            disabled={saving || tradeName.trim().length < 2 || displayName.trim().length < 2}
          >
            Começar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
