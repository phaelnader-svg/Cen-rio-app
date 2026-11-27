/**
 * Termômetro de uso das empresas (pedido do dono da plataforma, 2026-11-27): mostra se a tapeçaria
 * está usando de verdade (1º orçamento, aprovou, gerou OS, chamou funcionário, voltou no dia
 * seguinte) e há quantos dias ninguém entra. Empresa em teste parada há 2 dias vira aviso no
 * celular do dono da plataforma, com o WhatsApp pronto oferecendo ajuda.
 */
import {
  IDLE_NOTICE_DAYS,
  USAGE_STEPS,
  type PlatformUsageDto,
  type UsageStepKey,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { COMPANY_BILLING_SELECT, statusOf } from '../../core/billing';
import { now as clockNow } from '../../core/clock';
import { pushPlatformAdmins } from '../push/push';

type Usage = Omit<PlatformUsageDto, 'helpWhatsappUrl'>;
const DAY_MS = 86_400_000;

const spDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

export async function usageOf(
  system: PrismaClient,
  companies: { id: number; createdAt: Date }[],
  now: Date,
): Promise<Map<number, Usage>> {
  const ids = companies.map((c) => c.id);
  if (ids.length === 0) return new Map();
  const [quotes, orders, oss, invites, users, sessions, screens] = await Promise.all([
    system.quote.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids }, deletedAt: null },
      _min: { createdAt: true },
    }),
    system.commercialOrder.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids } },
      _min: { createdAt: true },
    }),
    system.serviceOrder.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids } },
      _min: { createdAt: true },
    }),
    system.employeeInvite.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids } },
      _min: { createdAt: true },
    }),
    system.user.findMany({
      where: { companyId: { in: ids }, supportAgent: false },
      select: { companyId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    system.session.findMany({
      where: { companyId: { in: ids }, user: { supportAgent: false } },
      select: { companyId: true, createdAt: true, lastSeenAt: true },
    }),
    system.screenView.groupBy({
      by: ['companyId', 'day'],
      where: { companyId: { in: ids } },
    }),
  ]);
  const minOf = (rows: { companyId: number; _min: { createdAt: Date | null } }[]) =>
    new Map(rows.map((r) => [r.companyId, r._min.createdAt]));
  const quote = minOf(quotes);
  const order = minOf(orders);
  const os = minOf(oss);
  const invite = minOf(invites);
  const seen = new Map<number, Date>();
  // Segundo usuário da empresa (o primeiro é quem criou a conta).
  const second = new Map<number, Date>();
  const firstSeen = new Set<number>();
  for (const u of users) {
    if (!firstSeen.has(u.companyId)) firstSeen.add(u.companyId);
    else if (!second.has(u.companyId)) second.set(u.companyId, u.createdAt);
  }
  // Dias em que entrou: telas abertas e o começo/fim de cada sessão (horário de São Paulo).
  const days = new Map<number, Set<string>>();
  const addDay = (id: number, day: string) => {
    const set = days.get(id) ?? new Set<string>();
    set.add(day);
    days.set(id, set);
  };
  for (const s of screens) addDay(s.companyId, s.day.toISOString().slice(0, 10));
  for (const s of sessions) {
    const prev = seen.get(s.companyId);
    if (!prev || s.lastSeenAt > prev) seen.set(s.companyId, s.lastSeenAt);
    addDay(s.companyId, spDay(s.createdAt));
    addDay(s.companyId, spDay(s.lastSeenAt));
  }

  const out = new Map<number, Usage>();
  for (const c of companies) {
    const signup = spDay(c.createdAt);
    const d = [...(days.get(c.id) ?? [])].sort();
    const last = seen.get(c.id) ?? null;
    const backDay = d.find((x) => x > signup) ?? null;
    const back: string | null = backDay
      ? `${backDay}T12:00:00.000Z`
      : last && spDay(last) > signup
        ? last.toISOString()
        : null;
    const invitedAt = [invite.get(c.id), second.get(c.id)]
      .filter((x): x is Date => !!x)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const at: Record<UsageStepKey, string | null> = {
      orcamento: quote.get(c.id)?.toISOString() ?? null,
      aprovou: order.get(c.id)?.toISOString() ?? null,
      os: os.get(c.id)?.toISOString() ?? null,
      funcionario: invitedAt?.toISOString() ?? null,
      voltou: back,
    };
    const done = Object.values(at).filter(Boolean).length;
    // Conta criada e nunca mais aberta: os dias contam a partir da criação.
    const since = last ?? c.createdAt;
    out.set(c.id, {
      steps: USAGE_STEPS.map((s) => ({ key: s.key, label: s.label, at: at[s.key] })),
      activeDays: d.length,
      lastSeenAt: last?.toISOString() ?? null,
      idleDays: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS)),
      level: done >= 4 ? 'quente' : done >= 2 ? 'morno' : 'frio',
    });
  }
  return out;
}

/**
 * Aviso no celular do dono da plataforma: empresa em teste que ficou IDLE_NOTICE_DAYS dias sem
 * entrar. Um aviso por parada: volta a avisar só se ela entrar de novo e parar outra vez.
 */
export async function sendIdleNotices(
  system: PrismaClient,
  webUrl: string,
  now = clockNow(),
): Promise<number> {
  const companies = await system.companySettings.findMany({
    where: {
      isPlatform: false,
      isDemo: false,
      billingCourtesy: false,
      canceledAt: null,
      closedAt: null,
      blockedAt: null,
    },
    select: { ...COMPANY_BILLING_SELECT, tradeName: true, idleNoticeAt: true, createdAt: true },
  });
  const trial = companies.filter((c) => statusOf(c, undefined, now) === 'TESTE');
  if (trial.length === 0) return 0;
  const usage = await usageOf(system, trial, now);
  let sent = 0;
  for (const c of trial) {
    const u = usage.get(c.id);
    if (!u || u.idleDays < IDLE_NOTICE_DAYS) continue;
    const since = u.lastSeenAt ? new Date(u.lastSeenAt) : c.createdAt;
    if (c.idleNoticeAt && c.idleNoticeAt >= since) continue;
    await system.companySettings.update({
      where: { id: c.id },
      data: { idleNoticeAt: now },
    });
    const done = u.steps.filter((s) => s.at).length;
    await pushPlatformAdmins(system, webUrl, {
      title: `${c.tradeName} parou de entrar`,
      body:
        `Está no teste grátis e não entra há ${u.idleDays} dias` +
        (done === 0 ? ', sem nenhum orçamento ainda.' : ` (${done} de 5 passos feitos).`) +
        ' Toque para oferecer ajuda pelo WhatsApp.',
      url: `/plataforma/empresas?parada=${c.id}`,
      tag: `parada-${c.id}`,
    }).catch(() => 0);
    sent++;
  }
  return sent;
}
