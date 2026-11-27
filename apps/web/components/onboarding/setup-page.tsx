'use client';

import Link from 'next/link';
import { Card, Spinner } from '@/components/ui/misc';
import { useGettingStarted } from '@/lib/onboarding';
import { SetupWizard } from './setup-wizard';

/** /painel/comecar: as perguntas do primeiro acesso, uma vez só. */
export function SetupPage() {
  const gs = useGettingStarted();
  if (gs.isPending) return <Spinner />;
  const done = gs.data?.steps.find((s) => s.key === 'perguntas')?.done ?? true;
  if (done || !gs.data) {
    return (
      <Card className="mx-auto max-w-xl p-6 text-center" data-testid="setup-done">
        <p className="text-lg font-semibold">As perguntas do começo já foram respondidas.</p>
        <p className="mt-2 text-ink-muted">
          Para mudar os preços, use a aba Base de dados do orçamento. O horário fica na tela
          Empresa.
        </p>
        <Link
          href="/painel"
          className="mt-4 inline-block font-semibold text-brand-700 hover:underline"
        >
          Voltar para o Início
        </Link>
      </Card>
    );
  }
  return <SetupWizard />;
}
