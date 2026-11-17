/**
 * "Falar com a Cenário" — interpreta a frase, valida e resolve com os dados reais.
 *
 * Interpretação: modelo de linguagem quando configurado (GAME_AI_PROVIDER=anthropic e
 * ANTHROPIC_API_KEY), com saída estruturada e validação pelo mesmo esquema zod; sem modelo (ou
 * se ele falhar), regras locais. O resultado é sempre uma INTENÇÃO validada; o servidor resolve
 * com as mesmas permissões das telas e devolve um EFEITO. Nada é alterado aqui: mudanças na planta
 * voltam como prévia e atribuições como dados para confirmar — a execução usa as rotas oficiais.
 */
import { requireCompanyId } from '../../core/tenant';
import Anthropic from '@anthropic-ai/sdk';
import {
  formatNumber,
  ACTIVITY_LABEL_GAME,
  AREA_FUNCTION_LABEL,
  COMMAND_INTENT_JSON_SCHEMA,
  COMMAND_SYSTEM_PROMPT,
  type CommandEffect,
  type CommandIntent,
  type CommandOption,
  type CommandResultDto,
  type GameSpaceDto,
  type Rect,
  catalogOf,
  center,
  commandIntentSchema,
  commandRequestSchema,
  findSpots,
  footprint,
  formatServiceOrderItemCode,
  normCmd,
  parseCommandRules,
  rectOfArea,
  slotAddress,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { now as clockNow } from '../../core/clock';
import { serviceOrderCode } from '../commercial/common';
import { GAME_ACCESS, contentOf, ensureDefaultSpaces, loadAllSpaces, num } from './common';

/** Código do material do estoque (mesmo formato do cadastro: MT-0001). */
const stockItemCode = (n: number) => formatNumber('MT', n);

const GONE = ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'];
const UNIT: Record<string, string> = {
  METRO: 'm',
  METRO_QUADRADO: 'm²',
  PLACA: 'placa(s)',
  PECA: 'peça(s)',
  UNIDADE: 'un.',
  EMBALAGEM: 'emb.',
};
const q = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const tokens = (s: string) =>
  normCmd(s)
    .split(' ')
    .filter(
      (w) =>
        w.length > 1 &&
        ![
          'o',
          'a',
          'os',
          'as',
          'de',
          'da',
          'do',
          'das',
          'dos',
          'e',
          'pra',
          'para',
          'perto',
          'lado',
          'sofa',
          'sofas',
          'movel',
          'servico',
        ].includes(w),
    );
const has = (hay: string, needles: string[]) => {
  const h = normCmd(hay);
  return needles.every((n) => h.includes(n));
};

export function aiProvider() {
  const provider = (process.env.GAME_AI_PROVIDER ?? 'regras').toLowerCase();
  return provider === 'anthropic' && process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'regras';
}

/** Interpretação pelo modelo (saída estruturada) → validada pelo esquema; null se indisponível. */
async function interpretWithModel(text: string, today: string): Promise<CommandIntent | null> {
  if (aiProvider() !== 'anthropic') return null;
  try {
    const client = new Anthropic({ timeout: 20_000, maxRetries: 1 });
    const response = await client.beta.messages.create({
      model: process.env.GAME_AI_MODEL || 'claude-opus-5-5',
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: COMMAND_SYSTEM_PROMPT,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: COMMAND_INTENT_JSON_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      messages: [{ role: 'user', content: `Hoje é ${today}. Frase: ${text}` }],
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
    if (response.stop_reason === 'refusal') return null;
    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    const parsed = commandIntentSchema.safeParse(JSON.parse(block.text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // sem rede, chave inválida ou resposta fora do esquema → regras
  }
}

type Ctx = {
  prisma: PrismaClient;
  perms: ReadonlySet<string>;
  spaceKey: string;
  today: string;
  /** Quem pediu (auditoria das ações preparadas pelo chat). */
  actor?: ActorContext;
};

const can = (ctx: Ctx, ...p: string[]) => p.some((x) => ctx.perms.has(x));

// ───────────────────────────── Encontrar OS ─────────────────────────────

async function serviceOrdersMatching(ctx: Ctx, intent: CommandIntent) {
  const include = {
    customer: { select: { name: true } },
    items: {
      orderBy: { position: 'asc' as const },
      select: {
        id: true,
        position: true,
        description: true,
        pieceType: true,
        fulfillmentStage: true,
      },
    },
  };
  if (intent.osNumero) {
    const so = await ctx.prisma.serviceOrder.findFirst({
      where: { number: intent.osNumero },
      include,
    });
    return so ? [so] : [];
  }
  const terms = tokens(intent.termo ?? '');
  if (!terms.length) return [];
  const rows = await ctx.prisma.serviceOrder.findMany({
    include,
    orderBy: [{ status: 'asc' }, { number: 'desc' }],
    take: 500,
  });
  return rows.filter((so) =>
    has(`${so.customer.name} ${so.items.map((i) => i.description).join(' ')}`, terms),
  );
}

function effectForOs(
  so: Awaited<ReturnType<typeof serviceOrdersMatching>>[number],
  furniture: string | null,
): { effect: CommandEffect; reply: string } {
  const code = serviceOrderCode(so.number);
  const onMap =
    so.status === 'ABERTA' ? so.items.filter((i) => !GONE.includes(i.fulfillmentStage)) : [];
  const pick =
    onMap.find((i) => furniture && normCmd(i.description).includes(furniture)) ?? onMap[0];
  if (pick)
    return {
      effect: { kind: 'ABRIR_PECA', pieceId: pick.id, serviceOrderId: so.id },
      reply: `${formatServiceOrderItemCode(so.number, pick.position)} · ${pick.description} de ${so.customer.name}. Levei a câmera até o móvel e abri a ficha.${onMap.length > 1 ? ` A OS tem mais ${onMap.length - 1} peça(s) no mapa.` : ''}`,
    };
  const why =
    so.status === 'CANCELADA'
      ? 'a OS foi cancelada'
      : so.items.every((i) => i.fulfillmentStage === 'ENTREGUE')
        ? 'as peças já foram entregues'
        : 'nenhuma peça está na oficina';
  return {
    effect: { kind: 'ABRIR_OS_SEM_POSICAO', serviceOrderId: so.id, osCode: code },
    reply: `${code} de ${so.customer.name} existe, mas está sem posição no mapa (${why}). Abri a ficha.`,
  };
}

async function findOs(ctx: Ctx, intent: CommandIntent) {
  if (!can(ctx, 'producao.ver', 'producao.planejar', 'os.ver'))
    return {
      reply: 'Sua conta não pode consultar ordens de serviço.',
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const found = await serviceOrdersMatching(ctx, intent);
  const furniture =
    /\b(sofa|poltrona|cabeceira|cadeira|pufe|banco|colchao)\b/.exec(
      normCmd(intent.termo ?? intent.pedido ?? ''),
    )?.[1] ?? null;
  if (!found.length)
    return {
      reply: intent.osNumero
        ? `Não encontrei a OS ${intent.osNumero}.`
        : `Não encontrei OS de "${intent.termo}". Tente o número da OS ou outro nome.`,
      effect: { kind: 'NADA' } as CommandEffect,
    };
  if (found.length === 1) return effectForOs(found[0]!, furniture);
  const options: CommandOption[] = found.slice(0, 8).map((so) => ({
    label: `${serviceOrderCode(so.number)} · ${so.customer.name}`,
    detail: `${so.items.map((i) => i.description).join(', ')}${so.status !== 'ABERTA' ? ` (${so.status.toLowerCase()})` : ''}`,
    effect: effectForOs(so, furniture).effect,
  }));
  return {
    reply: `Encontrei ${found.length} OS para "${intent.termo}". Qual delas?`,
    effect: { kind: 'ESCOLHER', options } as CommandEffect,
  };
}

// ───────────────────────────── Localizar material ─────────────────────────────

async function findMaterial(ctx: Ctx, intent: CommandIntent) {
  if (!can(ctx, 'estoque.ver', 'estoque.gerenciar'))
    return {
      reply: 'Sua conta não pode consultar o estoque.',
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const terms = tokens(intent.termo ?? '');
  if (!terms.length)
    return {
      reply: 'Qual material? Ex.: "Onde fica a espuma D28?"',
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const items = (await ctx.prisma.stockItem.findMany({ where: { active: true } })).filter((it) =>
    has(
      `${it.description} ${it.foamDensity ?? ''} ${it.kind === 'ESPUMA' ? 'espuma' : ''} ${stockItemCode(it.number)}`,
      terms,
    ),
  );
  const links = await ctx.prisma.gameSlotMaterial.findMany({
    where: {
      stockItemId: { in: items.map((i) => i.id) },
      slot: { active: true, unit: { active: true, space: { active: true } } },
    },
    include: { slot: { include: { unit: { include: { area: true, space: true } } } } },
  });
  const effect: CommandEffect = {
    kind: 'MATERIAL',
    items: items.map((it) => ({
      stockItemId: it.id,
      code: stockItemCode(it.number),
      description: `${it.description}${it.foamDensity && !it.description.includes(it.foamDensity) ? ` ${it.foamDensity}` : ''}`,
      onHand: num(it.onHand),
      reserved: num(it.reserved),
      available: Math.round((num(it.onHand) - num(it.reserved)) * 1000) / 1000,
      unit: it.unit,
      locations: links
        .filter((l) => l.stockItemId === it.id)
        .map((l) => ({
          spaceKey: l.slot.unit.space.key,
          unitId: l.slot.unitId,
          slotId: l.slotId,
          address: slotAddress(
            l.slot.unit.space.name,
            l.slot.unit.area?.name ?? null,
            l.slot.unit.label,
            l.slot.label,
          ),
        })),
    })),
    // Tecido da OS: as necessidades formais de material saíram do Cenário.
    exclusive: [],
  };
  const lines: string[] = [];
  for (const it of effect.items) {
    const u = UNIT[it.unit] ?? it.unit;
    lines.push(
      it.locations.length
        ? `${it.description}: ${it.locations.map((l) => l.address).join(' | ')}. Saldo ${q(it.onHand)} ${u} (reservado ${q(it.reserved)}, disponível ${q(it.available)}).`
        : `${it.description} (${it.code}) ainda não tem endereço no mapa. Saldo ${q(it.onHand)} ${u}, disponível ${q(it.available)}. Abri o item do estoque.`,
    );
  }
  for (const f of effect.exclusive)
    lines.push(
      `${f.description}: tecido exclusivo da ${f.osCode} (recebido ${q(f.received)} de ${q(f.need)} ${UNIT[f.unit] ?? f.unit}). Tecido de OS não tem posição de estante; fica com a OS.`,
    );
  if (!lines.length)
    return {
      reply: `Não encontrei "${intent.termo}" no estoque nem nas OS abertas.`,
      effect: { kind: 'NADA' } as CommandEffect,
    };
  return { reply: lines.join('\n'), effect };
}

// ───────────────────────────── Mover objeto ─────────────────────────────

type Obj = {
  id: string;
  name: string;
  kind: string;
  xCm: number;
  yCm: number;
  wCm: number;
  dCm: number;
  rotation: number;
};
const objectsOf = (s: GameSpaceDto): Obj[] => [
  ...s.stations.map((o) => ({ ...o, name: o.name })),
  ...s.storageUnits.map((o) => ({ ...o, name: o.label })),
  ...s.doc.decor.map((o) => ({ ...o, name: o.name ?? catalogOf(o.kind).label })),
];
const score = (name: string, kind: string, terms: string[]) => {
  const label = normCmd(`${name} ${catalogOf(kind).label}`);
  const hits = terms.filter((t) => label.includes(t)).length;
  return hits === terms.length ? hits * 10 - label.length / 100 : hits === 0 ? -1 : hits;
};

async function moveObject(ctx: Ctx, intent: CommandIntent) {
  if (!can(ctx, 'jogo.construir'))
    return {
      reply: 'Mover móveis exige a permissão de editar a planta.',
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const spaces = await loadAllSpaces(ctx.prisma);
  const oTerms = tokens(intent.objeto ?? '');
  const ranked = spaces
    .flatMap((s) =>
      objectsOf(s).map((o) => ({
        s,
        o,
        sc: score(o.name, o.kind, oTerms) + (s.key === ctx.spaceKey ? 0.5 : 0),
      })),
    )
    .filter((x) => x.sc >= oTerms.length * 10 - 1)
    .sort((a, b) => b.sc - a.sc);
  if (!ranked.length)
    return {
      reply: `Não achei "${intent.objeto}" na planta.`,
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const top = ranked.filter((r) => Math.abs(r.sc - ranked[0]!.sc) < 0.3);
  const previews = top.slice(0, 5).map((r) => previewMove(r.s, r.o, intent.destino ?? ''));
  if (previews.length > 1)
    return {
      reply: `Há ${previews.length} móveis com esse nome. Qual deles?`,
      effect: {
        kind: 'ESCOLHER',
        options: previews.map((p) => ({
          label: `${p.objectName}`,
          detail: p.reply,
          effect: p.effect,
        })),
      } as CommandEffect,
    };
  return { reply: previews[0]!.reply, effect: previews[0]!.effect };
}

function previewMove(space: GameSpaceDto, o: Obj, destino: string) {
  const l = contentOf(space);
  const dTerms = tokens(destino);
  const fnMatch = (fn: string) =>
    dTerms.some(
      (t) =>
        normCmd(AREA_FUNCTION_LABEL[fn as keyof typeof AREA_FUNCTION_LABEL] ?? '').includes(t) ||
        normCmd(fn).includes(t),
    );
  const area = l.areas.find((a) => dTerms.length && (has(a.name, dTerms) || fnMatch(a.function)));
  // Destino com nome de móvel ("bancada do Márcio") mira o móvel; só a função ("costura") mira a área.
  const namesFurniture =
    /\b(mesa|bancada|maquina|estante|prateleira|armario|gaveteiro|suporte|estrado|balcao|palete)\b/.test(
      normCmd(destino),
    );
  const target = (area && !namesFurniture ? [] : objectsOf(space))
    .filter((x) => x.id !== o.id)
    .map((x) => ({ x, sc: score(x.name, x.kind, dTerms) }))
    .filter((x) => x.sc >= dTerms.length * 10 - 1)
    .sort((a, b) => b.sc - a.sc)[0]?.x;
  const c = catalogOf(o.kind);
  const objectName = o.name;
  if (!area && !target)
    return {
      objectName,
      reply: `Não reconheci o destino "${destino}" na planta de ${space.name}.`,
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const targetRect: Rect = target ? footprint(target) : rectOfArea(area!);
  const targetLabel = target ? target.name : area!.name;
  const base = {
    wCm: o.wCm,
    dCm: o.dCm,
    frontClearCm: c.frontClearCm,
    ignoreId: o.id,
    keepMainPath: l.kind === 'OFICINA',
  };
  // Dentro da área pedida (ou colado ao móvel pedido), sem sobrepor nada e sem travar o caminho.
  const inside = target
    ? []
    : findSpots(l, { ...base, prefer: targetRect, near: center(targetRect) }, 4).filter(
        (s) => s.inPreferred,
      );
  const near = findSpots(l, { ...base, near: center(targetRect) }, 4);
  const spots = inside.length ? inside : near;
  const occupied = Boolean(target) || !inside.length;
  if (!spots.length)
    return {
      objectName,
      reply: `Não há espaço livre para ${objectName} perto de ${targetLabel}, nem caminho de sofá preservado. Libere uma área ou aumente a sala.`,
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const best = spots[0]!;
  const reply = target
    ? `${targetLabel} já ocupa esse lugar. Coloquei ${objectName} ao lado, no espaço livre mais próximo. Veja a prévia, ajuste arrastando e clique em Aplicar.`
    : occupied
      ? `${targetLabel} está sem espaço para ${objectName} (${c.wCm}×${c.dCm} cm com ${c.frontClearCm} cm de frente). Sugiro o vão livre mais perto dela. Prévia no mapa.`
      : `Prévia: ${objectName} dentro de ${targetLabel}, com passagem livre. Ajuste arrastando e clique em Aplicar.`;
  return {
    objectName,
    reply,
    effect: {
      kind: 'MOVER_PREVIA',
      spaceKey: space.key,
      objectId: o.id,
      objectName,
      targetLabel,
      from: { xCm: o.xCm, yCm: o.yCm, rotation: o.rotation },
      to: { xCm: Math.round(best.rect.x), yCm: Math.round(best.rect.y), rotation: best.rotation },
      occupied,
      alternatives: spots.slice(1).map((s) => ({
        xCm: Math.round(s.rect.x),
        yCm: Math.round(s.rect.y),
        rotation: s.rotation,
      })),
    } as CommandEffect,
  };
}

// ───────────────────────────── Atribuir etapa ─────────────────────────────

const STAGE_ACTIVITIES: Record<string, string[]> = {
  DESMONTAGEM: ['DESMONTAGEM', 'PREPARACAO'],
  PREPARACAO: ['PREPARACAO', 'DESMONTAGEM'],
  CORTE: ['CORTE_TECIDO', 'CORTE_ESPUMA', 'CORTE'],
  COSTURA: ['COSTURA', 'CORTE_TECIDO'],
  MONTAGEM: ['MONTAGEM', 'REVESTIMENTO', 'ACABAMENTO'],
  ACABAMENTO: ['ACABAMENTO', 'MONTAGEM'],
  EMBALAGEM: ['EMBALAGEM'],
};

async function assign(ctx: Ctx, intent: CommandIntent) {
  if (!can(ctx, 'producao.planejar'))
    return {
      reply: 'Atribuir trabalho exige permissão de planejar a produção.',
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const found = await serviceOrdersMatching(ctx, intent);
  if (found.length !== 1)
    return {
      reply: found.length
        ? 'Mais de uma OS combina. Diga o número (ex.: "OS 12").'
        : 'Não encontrei a OS. Diga o número (ex.: "OS 12").',
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const so = found[0]!;
  const people = await ctx.prisma.employee.findMany({
    where: { active: true, user: { active: true } },
    include: { user: { include: { roles: { include: { role: true } } } } },
  });
  const who = people.find((p) =>
    normCmd(p.displayName).startsWith(normCmd(intent.funcionario ?? '_')),
  );
  if (!who)
    return {
      reply: `Não achei o funcionário "${intent.funcionario}".`,
      effect: { kind: 'NADA' } as CommandEffect,
    };
  const acts = STAGE_ACTIVITIES[intent.etapa ?? ''] ?? [];
  const tasks = await ctx.prisma.productionTask.findMany({
    where: {
      serviceOrderId: so.id,
      status: { notIn: ['CANCELADA', 'CONCLUIDA', 'EM_EXECUCAO', 'PAUSADA'] },
    },
    include: {
      plan: { select: { status: true } },
      serviceOrderItem: { select: { position: true } },
    },
    orderBy: [{ sequence: 'asc' }, { number: 'asc' }],
  });
  const task = tasks.find((t) => acts.includes(t.activity)) ?? null;
  const code = serviceOrderCode(so.number);
  const etapa = ACTIVITY_LABEL_GAME[task?.activity ?? acts[0] ?? ''] ?? intent.etapa ?? 'Etapa';
  const data = intent.data ?? task?.scheduledAt?.toISOString().slice(0, 10) ?? ctx.today;
  if (task) {
    const effect: CommandEffect = {
      kind: 'ATRIBUIR_PREVIA',
      mode: 'TROCAR_RESPONSAVEL',
      serviceOrderId: so.id,
      osCode: code,
      pieceLabel: task.serviceOrderItem
        ? formatServiceOrderItemCode(so.number, task.serviceOrderItem.position)
        : code,
      etapa: `${etapa} (${task.title})`,
      funcionario: who.displayName,
      userId: who.userId,
      data,
      taskId: task.id,
      taskVersion: task.version,
      published: task.status !== 'RASCUNHO',
      pieces: [],
    };
    return {
      reply: `Confira antes de confirmar: ${code}, etapa ${etapa}, para ${who.displayName}${task.status !== 'RASCUNHO' ? ' (troca registrada com motivo)' : ''}. O início continua sendo confirmado por ${who.displayName} no tablet.`,
      effect,
    };
  }
  if (
    tasks.length ||
    (await ctx.prisma.productionTask.count({
      where: { serviceOrderId: so.id, status: { not: 'CANCELADA' } },
    }))
  )
    return {
      reply: `${code} não tem etapa de ${etapa.toLowerCase()} pendente para trocar.`,
      effect: { kind: 'NADA' } as CommandEffect,
    };
  // Sem planejamento: prévia do planejamento oficial (titular por peça + data).
  const isUph = who.user.roles.some((r) => r.role.key === 'tapeceiro');
  const fallbackUph = people.find((p) => p.user.roles.some((r) => r.role.key === 'tapeceiro'));
  const pieces = so.items.map((i) => ({
    serviceOrderItemId: i.id,
    upholstererUserId: isUph ? who.userId : (fallbackUph?.userId ?? who.userId),
  }));
  const effect: CommandEffect = {
    kind: 'ATRIBUIR_PREVIA',
    mode: 'PLANEJAR',
    serviceOrderId: so.id,
    osCode: code,
    pieceLabel: so.items.map((i) => formatServiceOrderItemCode(so.number, i.position)).join(', '),
    etapa,
    funcionario: who.displayName,
    userId: who.userId,
    data: data < ctx.today ? ctx.today : data,
    taskId: null,
    taskVersion: null,
    published: false,
    pieces,
  };
  return {
    reply: `${code} ainda não foi planejada. Prévia do planejamento: início ${data.split('-').reverse().join('/')}; ${isUph ? `${who.displayName} como titular` : `titular ${fallbackUph?.displayName ?? who.displayName}; a preparação segue o responsável padrão`}. Depois de confirmar, publique a semana para ir à fila dos tablets.`,
    effect,
  };
}

// ───────────────────────────── Rota ─────────────────────────────

export async function resolveIntent(
  ctx: Ctx,
  intent: CommandIntent,
): Promise<{ reply: string; effect: CommandEffect }> {
  switch (intent.acao) {
    case 'ENCONTRAR_OS':
      return findOs(ctx, intent);
    case 'LOCALIZAR_MATERIAL':
      return findMaterial(ctx, intent);
    case 'MOVER_OBJETO':
      return moveObject(ctx, intent);
    case 'PLANTA': {
      if (!can(ctx, 'jogo.construir'))
        return {
          reply: 'Mexer na planta exige a permissão de editar a planta.',
          effect: { kind: 'NADA' },
        };
      const t = normCmd(intent.pedido ?? '');
      const spaceKey = /escritorio|agente/.test(t)
        ? 'ESCRITORIO'
        : /tapecaria|oficina|bancada|tapeceir|marcenaria|corte|costura/.test(t)
          ? 'TAPECARIA'
          : ctx.spaceKey;
      return {
        reply: 'Chamei o Mestre de Obras com o seu pedido. A prévia aparece no mapa.',
        effect: { kind: 'PLANTA', spaceKey, text: intent.pedido ?? '' },
      };
    }
    case 'ATRIBUIR':
      return assign(ctx, intent);
    case 'CONVERSAS':
    case 'FINANCEIRO':
      return officeHook(ctx, intent);
    default:
      return {
        reply: `Posso encontrar OS, localizar materiais, mover móveis, ajudar com a planta e preparar atribuições. Exemplos: ${(await realSuggestions(ctx.prisma)).slice(0, 4).join(' · ')}`,
        effect: { kind: 'NADA' },
      };
  }
}

/** Ganchos do escritório (conversas e financeiro): registrados pelos módulos que os atendem. */
type OfficeHook = (
  ctx: Ctx,
  intent: CommandIntent,
) => Promise<{ reply: string; effect: CommandEffect }>;
const hooks: OfficeHook[] = [];
export const registerOfficeHook = (h: OfficeHook) => hooks.push(h);
async function officeHook(ctx: Ctx, intent: CommandIntent) {
  for (const h of hooks) {
    const r = await h(ctx, intent);
    if (r.effect.kind !== 'NADA' || r.reply) return r;
  }
  return {
    reply: 'Esse tipo de pedido ainda não está disponível nesta versão.',
    effect: { kind: 'NADA' } as CommandEffect,
  };
}
export type { Ctx as CommandCtx };

export async function gameCommandRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get('/api/v1/game/command/config', { config: { access: GAME_ACCESS } }, async () => ({
    provider: aiProvider(),
    model: aiProvider() === 'anthropic' ? process.env.GAME_AI_MODEL || 'claude-opus-5-5' : null,
    suggestions: await realSuggestions(prisma),
  }));

  app.post(
    '/api/v1/game/command',
    { config: { access: GAME_ACCESS } },
    async (request: FastifyRequest): Promise<CommandResultDto> => {
      const input = commandRequestSchema.parse(request.body);
      await ensureDefaultSpaces(prisma);
      const s = await prisma.companySettings.findUnique({ where: { id: requireCompanyId() } });
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: s?.timezone ?? 'America/Sao_Paulo',
      }).format(clockNow());
      const byModel = await interpretWithModel(input.text, today);
      const intent = byModel ?? parseCommandRules(input.text, today);
      const ctx: Ctx = {
        prisma,
        perms: request.auth!.permissions,
        spaceKey: input.spaceKey ?? 'TAPECARIA',
        today,
        actor: actorFrom(request),
      };
      const { reply, effect } = await resolveIntent(ctx, intent);
      await prisma.$transaction((tx) =>
        audit(tx, actorFrom(request), {
          action: 'game.command',
          entityType: 'game_command',
          summary: `Falar com a Cenário: "${input.text.slice(0, 120)}" → ${intent.acao} (${effect.kind})`,
          changes: { interpretedBy: byModel ? 'IA' : 'REGRAS', intent },
        }),
      );
      return { interpretedBy: byModel ? 'IA' : 'REGRAS', intent, reply, effect };
    },
  );
}

/**
 * Sugestões do chat com os nomes reais da empresa (cliente, OS, material, pessoa e meta). O que
 * a empresa ainda não tem cai no exemplo genérico, sem nomes de outra empresa.
 */
export async function realSuggestions(prisma: PrismaClient): Promise<string[]> {
  const [so, material, person, goal] = await Promise.all([
    prisma.serviceOrder.findFirst({
      where: { status: 'ABERTA' },
      orderBy: { number: 'desc' },
      select: {
        number: true,
        customer: { select: { name: true } },
        items: { select: { description: true }, orderBy: { position: 'asc' }, take: 1 },
      },
    }),
    prisma.inventoryItem.findFirst({ select: { name: true }, orderBy: { createdAt: 'asc' } }),
    prisma.employee.findFirst({
      where: { active: true, user: { active: true } },
      select: { displayName: true },
      orderBy: { displayName: 'asc' },
    }),
    prisma.cashGoal.findFirst({
      where: { active: true },
      orderBy: { targetCents: 'asc' },
      select: { targetCents: true },
    }),
  ]);
  const first = (s: string) => s.trim().split(/\s+/)[0] ?? s;
  const piece = (so?.items[0]?.description ?? 'sofá').toLowerCase().split(/\s+/)[0];
  const thousand = goal ? Math.round(goal.targetCents / 100_000) : null;
  return [
    so ? `Cadê o ${piece} da ${first(so.customer.name)}?` : 'Cadê o sofá do cliente?',
    so ? `Abre a OS ${so.number}` : 'Abre a última OS',
    material ? `Onde fica ${material.name}?` : 'Onde fica o tecido?',
    'Joga a mesa de corte pra perto da costura',
    so && person
      ? `Passa a próxima etapa da OS ${so.number} pro ${first(person.displayName)} amanhã`
      : 'Quem está sem tarefa hoje?',
    'Coloca mais duas mesas perto da janela',
    'Cria uma mesa para o agente de compras',
    thousand ? `Quanto falta pra bater os ${thousand} mil?` : 'Quanto entrou no caixa essa semana?',
    'Quanto eu cresci essa semana?',
  ];
}
