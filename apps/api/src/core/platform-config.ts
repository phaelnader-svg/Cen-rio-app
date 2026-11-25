import { PLANS, type BillingCycle, type PlanKey } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';

/**
 * Painel da plataforma (2026-11-25): preços, teste grátis, bloqueio e como o dono da plataforma
 * recebe (PIX e WhatsApp) ficam no banco (`platform_settings`, uma linha) e são editados no
 * painel /plataforma. A API guarda uma cópia em memória, relida a cada 30 segundos (e na hora,
 * depois de salvar), porque a situação da assinatura é calculada em toda requisição.
 */
export interface PlatformConfig {
  prices: Record<PlanKey, number>;
  annualDiscountBps: number;
  trialDays: number;
  graceDays: number;
  /** Bloqueio automático por falta de pagamento (cobrança manual, sem Asaas). */
  autoBlock: boolean;
  noticeDays: number;
  pixKey: string | null;
  pixName: string | null;
  pixBank: string | null;
  whatsapp: string | null;
  paymentMessage: string | null;
  /** A tapeçaria liberada pelo painel para usar as conexões do servidor (ou nenhuma). */
  serverConnectionsCompanyId: number | null;
}

export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  prices: { gestao: PLANS.gestao.monthlyCents, gestao_jogo: PLANS.gestao_jogo.monthlyCents },
  annualDiscountBps: 1500,
  trialDays: 7,
  graceDays: 5,
  autoBlock: false,
  noticeDays: 3,
  pixKey: null,
  pixName: null,
  pixBank: null,
  whatsapp: null,
  paymentMessage: null,
  serverConnectionsCompanyId: null,
};

const TTL_MS = 30_000;
let current: PlatformConfig = DEFAULT_PLATFORM_CONFIG;
let loadedAt = 0;
let loading: Promise<PlatformConfig> | null = null;

type Row = NonNullable<Awaited<ReturnType<PrismaClient['platformSettings']['findUnique']>>>;

export function configFromRow(
  r: Row,
  serverConnectionsCompanyId: number | null = null,
): PlatformConfig {
  return {
    serverConnectionsCompanyId,
    prices: { gestao: r.priceGestaoCents, gestao_jogo: r.priceJogoCents },
    annualDiscountBps: r.annualDiscountBps,
    trialDays: r.trialDays,
    graceDays: r.graceDays,
    autoBlock: r.autoBlock,
    noticeDays: r.noticeDays,
    pixKey: r.pixKey,
    pixName: r.pixName,
    pixBank: r.pixBank,
    whatsapp: r.whatsapp,
    paymentMessage: r.paymentMessage,
  };
}

/** A configuração em memória (a última lida do banco; os valores de fábrica até a 1ª leitura). */
export function platformConfig(): PlatformConfig {
  return current;
}

/** Relê do banco se a cópia passou de 30 s (ou sempre, com `force`). Falha = mantém a cópia. */
export async function refreshPlatformConfig(
  system: PrismaClient,
  force = false,
): Promise<PlatformConfig> {
  if (!force && Date.now() - loadedAt < TTL_MS) return current;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const [row, conn] = await Promise.all([
        system.platformSettings.findUnique({ where: { id: 1 } }),
        system.companySettings.findFirst({
          where: { serverConnections: true, isPlatform: false },
          select: { id: true },
        }),
      ]);
      const connId = conn?.id ?? null;
      current = row
        ? configFromRow(row, connId)
        : { ...DEFAULT_PLATFORM_CONFIG, serverConnectionsCompanyId: connId };
      loadedAt = Date.now();
    } finally {
      loading = null;
    }
    return current;
  })();
  return loading;
}

/** Só para testes: volta aos valores de fábrica e força a próxima leitura. */
export function resetPlatformConfigCache() {
  current = DEFAULT_PLATFORM_CONFIG;
  loadedAt = 0;
}

/** Preço do plano no ciclo (anual = 12 meses com o desconto), pela tabela do painel. */
export function listPriceCents(plan: PlanKey, cycle: BillingCycle, cfg = current): number {
  const monthly = cfg.prices[plan];
  if (cycle === 'MENSAL') return monthly;
  return Math.round((monthly * 12 * (10_000 - cfg.annualDiscountBps)) / 10_000);
}

/** O que a empresa paga por ciclo: o valor combinado com ela ou o preço da tabela. */
export function companyPriceCents(c: {
  plan: PlanKey;
  cycle: BillingCycle;
  billingPriceCents: number | null;
}): number {
  return c.billingPriceCents ?? listPriceCents(c.plan, c.cycle);
}

/** Link do WhatsApp do dono da plataforma (wa.me), com a mensagem pronta. */
export function whatsappLink(text: string, cfg = current): string | null {
  const digits = (cfg.whatsapp ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const full = digits.length <= 11 ? `55${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

/** A tapeçaria liberada para usar as conexões do servidor (WhatsApp, Instagram…), ou nenhuma. */
export function serverConnectionsCompanyId(): number | null {
  return current.serverConnectionsCompanyId;
}
