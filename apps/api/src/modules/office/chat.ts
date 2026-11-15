/**
 * "Falar com a Cenário" — pedidos financeiros. Consultas respondem na hora; o que envia, cobra,
 * emite ou paga só PREPARA e abre a ficha/painel para revisão (nada sai sem a sua confirmação).
 */
import type { CommandEffect } from '@cenario/shared';
import { registerOfficeHook } from '../game/command';
import { orderRevenue } from '../finance/revenue';
import { shopTimezone, todayIso } from '../finance/common';
import { brl, osCodeOf } from './common';
import { planCharges } from './charges';
import { prepareContract } from './contracts';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const WEEKDAYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
/** "hoje", "amanhã", "sexta", "dia 20" → AAAA-MM-DD. */
export function dateIn(t: string, today: string): string | null {
  if (/\bdepois de amanha\b/.test(t)) return addDays(today, 2);
  if (/\bamanha\b/.test(t)) return addDays(today, 1);
  if (/\bhoje\b/.test(t)) return today;
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}(-feira)?\\b`).test(t));
  if (wd >= 0) {
    const cur = new Date(`${today}T12:00:00Z`).getUTCDay();
    return addDays(today, (wd - cur + 7) % 7 || 7);
  }
  const dm = /\bdia (\d{1,2})\b/.exec(t);
  if (dm) {
    const d = Number(dm[1]);
    const [y, m] = today.split('-').map(Number) as [number, number];
    const cand = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return cand >= today
      ? cand
      : `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}
const br = (iso: string) => iso.split('-').reverse().join('/');
const nada = (reply: string) => ({ reply, effect: { kind: 'NADA' } as CommandEffect });

registerOfficeHook(async (ctx, intent) => {
  if (intent.acao !== 'FINANCEIRO') return { reply: '', effect: { kind: 'NADA' } };
  const { prisma, perms } = ctx;
  const text = intent.pedido ?? '';
  const t = norm(text);
  const today = todayIso(await shopTimezone(prisma));
  const finView = perms.has('financeiro.ver');

  // Fechamento: notas e comprovantes do mês.
  if (
    /\b(notas?|comprovantes?|fechamento|fechar o mes|contabil)/.test(t) &&
    /\bmes\b|fechamento|fechar|contabil/.test(t)
  ) {
    if (!finView) return nada('Fechamento do mês exige a permissão financeiro.ver.');
    return {
      reply: `Abri o fechamento de ${br(today).slice(3)}: notas emitidas, comprovantes, extratos e o que está faltando. Dá para baixar o pacote para a contabilidade.`,
      effect: { kind: 'ABRIR_PAINEL', panel: 'FINANCEIRO', filter: 'FECHAMENTO' },
    };
  }

  // Entregas com saldo.
  if (/\bentregas?\b/.test(t)) {
    const date = dateIn(t, today) ?? today;
    const rows = await prisma.delivery.findMany({
      where: { scheduledDate: new Date(`${date}T00:00:00Z`), status: { notIn: ['CANCELADA'] } },
      include: {
        customer: true,
        items: {
          where: { active: true },
          include: { serviceOrderItem: { include: { serviceOrder: true } } },
        },
      },
    });
    const out = [];
    for (const d of rows) {
      const soIds = [...new Set(d.items.map((i) => i.serviceOrderItem.serviceOrder))];
      let open = 0;
      for (const so of soIds) {
        const r = await orderRevenue(prisma, so.orderId);
        open += Math.max(0, (r.finalCents ?? 0) - r.receivedCents);
      }
      if (/saldo|receber|cobrar/.test(t) && open <= 0) continue;
      out.push({
        label: `${d.customer.name} — ${soIds.map((s) => osCodeOf(s.number)).join(', ')}`,
        detail: open > 0 ? `saldo ${brl(open)} a cobrar na entrega` : 'quitado',
        effect: soIds[0]
          ? ({
              kind: 'ABRIR_PAINEL',
              panel: 'FINANCEIRO',
              serviceOrderId: soIds[0].id,
            } as CommandEffect)
          : null,
      });
    }
    if (!out.length)
      return {
        reply: `Nenhuma entrega${/saldo/.test(t) ? ' com saldo' : ''} em ${br(date)}.`,
        effect: { kind: 'ABRIR_PAINEL', panel: 'FINANCEIRO', filter: `ENTREGAS:${date}` },
      };
    return {
      reply: `${out.length} entrega(s) em ${br(date)}${/saldo/.test(t) ? ' com saldo a receber' : ''}.`,
      effect: { kind: 'LISTA', title: `Entregas de ${br(date)}`, rows: out },
    };
  }

  // Contas a pagar até uma data / de um fornecedor.
  if (
    /\b(contas?|pagar|pagamento|vencem|boletos?|fornecedor)\b/.test(t) &&
    !/\bentrada|cobra/.test(t)
  ) {
    if (!finView) return nada('Contas a pagar exigem a permissão financeiro.ver.');
    const until = dateIn(t, today);
    const sup =
      /\bfornecedor(?:a)? (?:de |da |do )?([a-z0-9 ]{3,30}?)(?:\s+(?:ate|para|que|de hoje|amanha)\b|$)/
        .exec(t)?.[1]
        ?.trim() ??
      /\b(?:pagamento|pagar|boleto) (?:da |do |de )?([a-z]{4,20})\b/.exec(t)?.[1] ??
      null;
    const rows = await prisma.accountPayable.findMany({
      where: {
        status: { in: ['ABERTO', 'PARCIAL'] },
        ...(until ? { dueDate: { lte: new Date(`${until}T00:00:00Z`) } } : {}),
        ...(sup
          ? {
              OR: [
                { beneficiary: { contains: sup, mode: 'insensitive' } },
                { description: { contains: sup, mode: 'insensitive' } },
                { supplier: { name: { contains: sup, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: { supplier: true },
      orderBy: { dueDate: 'asc' },
      take: 20,
    });
    const total = rows.reduce((a, p) => a + p.amountCents - p.paidCents, 0);
    if (!rows.length)
      return {
        reply: `Nenhuma conta em aberto${sup ? ` de "${sup}"` : ''}${until ? ` até ${br(until)}` : ''}.`,
        effect: { kind: 'ABRIR_PAINEL', panel: 'FINANCEIRO', filter: 'PAGAR' },
      };
    return {
      reply: `${rows.length} conta(s)${sup ? ` de "${sup}"` : ''}${until ? ` até ${br(until)}` : ''}: ${brl(total)}. ${/\bprepar|pagamento|pagar\b/.test(t) ? 'Toque numa conta para preparar o pagamento — você confere favorecido, valor, vencimento e conta de origem antes de confirmar; a autorização final é no app do banco.' : 'Toque para abrir.'}`,
      effect: {
        kind: 'LISTA',
        title: 'Contas a pagar',
        rows: rows.map((p) => ({
          label: `${p.supplier?.name ?? p.beneficiary} — ${brl(p.amountCents - p.paidCents)}`,
          detail: `${p.description} · vence ${br(p.dueDate.toISOString().slice(0, 10))}`,
          effect: {
            kind: 'ABRIR_PAINEL',
            panel: 'FINANCEIRO',
            filter: `PAGAR:${p.id}`,
          } as CommandEffect,
        })),
      },
    };
  }

  // OS pelo número ou pelo nome do cliente ("contrato da Ana", "entrada da OS 142").
  const who = /\b(?:da|do|de)\s+([a-z]{3,20})(?:\s+([a-z]{3,20}))?\b/.exec(t);
  const STOP = new Set([
    'os',
    'pix',
    'entrada',
    'saldo',
    'boleto',
    'cartao',
    'contrato',
    'nota',
    'cliente',
    'pedido',
    'mes',
    'hoje',
    'amanha',
  ]);
  const name = who && !STOP.has(who[1]!) ? who[1] : null;
  const sos = intent.osNumero
    ? await prisma.serviceOrder.findMany({
        where: { number: intent.osNumero },
        include: { customer: true },
      })
    : name
      ? await prisma.serviceOrder.findMany({
          where: { status: 'ABERTA', customer: { name: { contains: name, mode: 'insensitive' } } },
          include: { customer: true },
          take: 6,
          orderBy: { number: 'desc' },
        })
      : [];
  if (!sos.length)
    return nada(
      intent.osNumero || name
        ? `Não encontrei a OS ${intent.osNumero ?? `de "${name}"`}.`
        : 'Diga a OS ou o cliente (ex.: "contrato da Ana", "entrada por Pix da OS 142").',
    );
  if (sos.length > 1)
    return {
      reply: `Encontrei ${sos.length} OS para "${name}". Qual delas?`,
      effect: {
        kind: 'LISTA',
        title: 'Qual OS?',
        rows: sos.map((s) => ({
          label: `${osCodeOf(s.number)} — ${s.customer.name}`,
          detail: '',
          effect: {
            kind: 'ABRIR_PAINEL',
            panel: 'FINANCEIRO',
            serviceOrderId: s.id,
          } as CommandEffect,
        })),
      },
    };
  const so = sos[0]!;
  const open = (filter: string, reply: string) => ({
    reply,
    effect: {
      kind: 'ABRIR_PAINEL',
      panel: 'FINANCEIRO',
      serviceOrderId: so.id,
      filter,
    } as CommandEffect,
  });

  if (/\bcontrato\b/.test(t)) {
    const cur = await prisma.contract.findFirst({
      where: { orderId: so.orderId, status: { in: ['RASCUNHO', 'ENVIADO', 'ASSINADO'] } },
    });
    if (!cur && /\b(prepar|gera|faz|cria|monta)/.test(t) && perms.has('pedidos.gerenciar')) {
      const c = await prisma.$transaction((tx) =>
        prepareContract(
          tx,
          ctx.actor ?? { userId: null, sessionId: null, ip: null, requestId: null },
          so.orderId,
        ),
      );
      return open(
        'CONTRATO',
        `Preparei o contrato de ${so.customer.name} (${osCodeOf(so.number)}) pelo modelo da Cenário${c.missing.length ? `. Falta: ${c.missing.join(', ')}` : ''}. Revise o texto e os signatários antes de enviar para assinatura.`,
      );
    }
    return open(
      'CONTRATO',
      cur
        ? `Contrato de ${so.customer.name}: ${cur.status.toLowerCase()} (rev. ${cur.revision}).`
        : `${so.customer.name} ainda não tem contrato. Abri a ficha: use "Preparar contrato".`,
    );
  }
  if (/\b(entrada|cobranca|cobra|pix|boleto|parcela|cartao)\b/.test(t)) {
    const rev = await orderRevenue(prisma, so.orderId);
    if (rev.finalCents === null)
      return open('COBRANCA', `${osCodeOf(so.number)} não tem valor aprovado.`);
    const pct = /(\d{1,2})\s*%/.exec(t);
    const card = /cartao/.test(t);
    const inst = /(\d{1,2})\s*x\b/.exec(t);
    const lines = planCharges(
      rev.finalCents - rev.billedCents,
      {
        mode: card ? 'CARTAO_TOTAL' : 'ENTRADA_SALDO',
        entradaPercent: pct ? Number(pct[1]) : 50,
        installments: inst ? Number(inst[1]) : 1,
        method: /boleto/.test(t) ? 'BOLETO' : 'PIX',
        saldoTrigger: 'ENTREGA',
      },
      today,
    );
    if (!lines.length)
      return open(
        'COBRANCA',
        `Todo o valor de ${osCodeOf(so.number)} já está lançado. Abri as cobranças.`,
      );
    return open(
      `COBRANCA:${card ? `CARTAO:${inst?.[1] ?? 1}` : `ENTRADA:${pct?.[1] ?? 50}:${/boleto/.test(t) ? 'BOLETO' : 'PIX'}`}`,
      `Prévia para ${so.customer.name} (${osCodeOf(so.number)}, ${brl(rev.finalCents)}): ${lines.map((l) => `${l.description} ${brl(l.amountCents)}`).join(' + ')}. Confira e aprove na ficha para emitir a cobrança.`,
    );
  }
  if (/\bnota|nfs ?e|nf ?e\b/.test(t))
    return open(
      'NOTA',
      `Abri a nota de ${so.customer.name}: o agente prepara, você revisa e autoriza.`,
    );
  if (/\bsaldo\b/.test(t)) {
    const rev = await orderRevenue(prisma, so.orderId);
    return open(
      '',
      `${so.customer.name} (${osCodeOf(so.number)}): recebido ${brl(rev.receivedCents)} de ${brl(rev.finalCents ?? 0)}; saldo ${brl(Math.max(0, (rev.finalCents ?? 0) - rev.receivedCents))}.`,
    );
  }
  return open('', `Abri a ficha de ${so.customer.name} (${osCodeOf(so.number)}).`);
});
