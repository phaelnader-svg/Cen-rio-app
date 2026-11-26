'use client';

import { PLANS, PLAN_KEYS, type SignupPricingDto } from '@cenario/shared';
import { Check } from 'lucide-react';

/**
 * Criar conta (pedido do dono, 26/11/2026): quem se cadastra vê os preços antes, sabendo que o
 * cadastro e os dias de teste não custam nada, mas que o Cenário Gestão é pago depois disso.
 * Os valores vêm do painel da plataforma (Planos e preços); sem resposta da API, os de tabela.
 */
const FALLBACK: SignupPricingDto = {
  trialDays: 7,
  annualDiscountPct: 15,
  plans: PLAN_KEYS.map((key) => ({
    key,
    label: PLANS[key].label,
    description: PLANS[key].description,
    monthlyCents: PLANS[key].monthlyCents,
  })),
};

/** R$ 399 (sem ,00) ou R$ 399,90. */
export function reais(cents: number): string {
  const v = (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: cents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `R$ ${v}`;
}

export function pricingOrDefault(p: SignupPricingDto | undefined | null): SignupPricingDto {
  return p && p.plans.length ? p : FALLBACK;
}

export const cheapest = (p: SignupPricingDto) => Math.min(...p.plans.map((x) => x.monthlyCents));

/** Lado esquerdo da tela, no computador. */
export function SignupPricingPanel({ pricing }: { pricing: SignupPricingDto }) {
  const days = pricing.trialDays;
  return (
    <div className="max-w-md" data-testid="signup-precos">
      <h2 className="text-3xl leading-tight font-semibold tracking-tight text-balance">
        Teste grátis por {days} dias. Depois, escolha o seu plano.
      </h2>
      <ul className="mt-5 space-y-2 text-white/85">
        {[
          'Cadastro sem custo e sem cartão.',
          `${days} dias para usar o sistema inteiro, com a sua equipe.`,
          `Depois dos ${days} dias, para continuar, é só assinar um dos planos abaixo.`,
        ].map((t) => (
          <li key={t} className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-white" aria-hidden />
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7 space-y-3">
        {pricing.plans.map((p) => (
          <div
            key={p.key}
            className="rounded-xl border border-white/15 bg-white/5 p-4"
            data-testid={`signup-plano-${p.key}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-semibold">{p.label}</p>
              <p className="text-lg font-semibold whitespace-nowrap">
                {reais(p.monthlyCents)}
                <span className="text-sm font-normal text-white/75"> por mês</span>
              </p>
            </div>
            <p className="mt-1 text-sm text-white/75">{p.description}</p>
          </div>
        ))}
      </div>
      {pricing.annualDiscountPct > 0 && (
        <p className="mt-4 text-sm text-white/75">
          No plano anual, {pricing.annualDiscountPct}% de desconto.
        </p>
      )}
    </div>
  );
}

/** Aviso curto logo antes do botão (vale para celular e computador). */
export function signupPriceNotice(pricing: SignupPricingDto): string {
  return `Cadastro sem custo e ${pricing.trialDays} dias grátis para testar. Depois, o Cenário Gestão é pago: a partir de ${reais(cheapest(pricing))} por mês.`;
}
