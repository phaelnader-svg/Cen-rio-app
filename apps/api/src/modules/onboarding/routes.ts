import { pushPlatformAdmins } from '../push/push';
import {
  EVENT_TYPES,
  SETUP_CARD_FEES_BPS,
  SETUP_PIECES,
  SETUP_SUPPLIES,
  SETUP_TAX_BPS,
  acceptInviteSchema,
  gettingStartedSteps,
  helpRequestSchema,
  setupAnswersSchema,
  tipKeySchema,
  whatsappLink,
  type EmployeeInviteDto,
  type GettingStartedDto,
  type GettingStartedFacts,
  type PublicInviteDto,
  type SetupAnswers,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { lockRow } from '../../core/locking';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { moduleState } from '../../core/modules';
import { PLATFORM_RECORD_ID, requireCompanyId, runAsCompany } from '../../core/tenant';
import type { ActorContext } from '../../core/types';
import { randomUUID } from 'node:crypto';
import { hashSecret, randomToken, sha256Hex } from '../../lib/crypto';
import { sniffImageType } from '../../core/storage/storage';
import { processImage } from '../../core/storage/image';
import { Errors } from '../../lib/errors';
import { webUrl } from '../account/emails';
import { employeeEventPayload, idParams } from '../presenters';
import { roadKm } from './city-coords';

const OWNER = { session: 'WEB', permissions: ['empresa.configurar'] } as const;
const WEB = { session: 'WEB' } as const;
const MANAGE_EMPLOYEES = { session: 'WEB', permissions: ['funcionarios.gerenciar'] } as const;
const INVITE_TTL_MS = 7 * 86_400_000;

/** Nome curto da cidade para a lista do frete: "Jacareí - SP" → "Jacareí". */
const shortCity = (c: string) => c.replace(/\s+-\s+[A-Z]{2}$/, '').trim();

const addMinutes = (hhmm: string, minutes: number) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.min(Math.max(h! * 60 + m! + minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

const minutesBetween = (a: string, b: string) => {
  const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
  return m(b) - m(a);
};

/** Fatos do começo guiado de uma empresa (a transação já está presa a ela). */
export async function gettingStartedFacts(db: Tx | PrismaClient): Promise<GettingStartedFacts> {
  const companyId = requireCompanyId();
  const [company, labor, employees, devices, quotes, phoneApps, modules] = await Promise.all([
    db.companySettings.findUniqueOrThrow({
      where: { id: companyId },
      select: { setupDoneAt: true, teamSize: true },
    }),
    db.quoteCatalogItem.findMany({
      where: { kind: 'MAO_TAPECEIRO' },
      select: { priceCents: true },
    }),
    db.employee.count({ where: { active: true } }),
    db.device.count({ where: { status: 'ACTIVE' } }),
    db.quote.count({ where: { deletedAt: null } }),
    db.pushSubscription.count({ where: { app: 'DONO' } }),
    moduleState(db),
  ]);
  return {
    setupDone: company.setupDoneAt !== null,
    laborItems: labor.length,
    laborPriced: labor.filter((l) => l.priceCents !== null && l.priceCents > 0).length,
    otherEmployees: Math.max(employees - 1, 0),
    worksAlone: company.teamSize === 1,
    devices,
    noTablet: modules.oficina_sem_tablet,
    quotes,
    phoneApps,
  };
}

/** Monta a base do orçamento, o horário e a meta a partir das respostas (item 2). */
export async function applySetup(tx: Tx, actor: ActorContext, a: SetupAnswers) {
  const companyId = requireCompanyId();
  if (!(await lockRow(tx, 'company_settings', companyId)))
    throw Errors.notFound('Configuração da empresa');
  const company = await tx.companySettings.findUniqueOrThrow({ where: { id: companyId } });
  if (company.setupDoneAt)
    throw Errors.business(
      'As perguntas já foram respondidas. Os preços ficam em Orçamentos, e o horário na tela Empresa.',
    );

  const existing = await tx.quoteCatalogItem.findMany({ select: { kind: true, name: true } });
  const has = new Set(existing.map((e) => `${e.kind}|${e.name.toLowerCase()}`));
  const positions = new Map<string, number>();
  const nextPos = async (kind: string) => {
    if (!positions.has(kind)) {
      const last = await tx.quoteCatalogItem.aggregate({
        where: { kind },
        _max: { position: true },
      });
      positions.set(kind, last._max.position ?? 0);
    }
    const p = positions.get(kind)! + 1;
    positions.set(kind, p);
    return p;
  };
  let created = 0;
  const add = async (
    kind: string,
    data: Omit<Prisma.QuoteCatalogItemUncheckedCreateInput, 'kind' | 'position'>,
  ) => {
    const k = `${kind}|${data.name.toLowerCase()}`;
    if (has.has(k)) return null;
    has.add(k);
    created++;
    return tx.quoteCatalogItem.create({ data: { ...data, kind, position: await nextPos(kind) } });
  };

  // Mão de obra: só o nome das peças marcadas, preço em branco (decisão do dono, 26/11/2026).
  for (const key of a.pieces) {
    const piece = SETUP_PIECES.find((p) => p.key === key);
    for (const name of piece?.labor ?? []) {
      const item = await add('MAO_TAPECEIRO', { name, priceCents: null });
      if (item) await add('MAO_AJUDANTE', { name, priceCents: null, linkedItemId: item.id });
    }
  }
  for (const f of a.fabrics)
    await add('MATERIAL', {
      category: 'Tecidos',
      name: f.name,
      priceCents: f.priceCents,
      unit: 'm',
    });
  for (const f of a.foams)
    await add('MATERIAL', {
      category: 'Espumas',
      name: f.name,
      priceCents: f.priceCents,
      unit: 'm³',
    });
  for (const s of SETUP_SUPPLIES)
    await add('MATERIAL', { category: s.category, name: s.name, priceCents: null, unit: s.unit });

  // Frete: cada cidade com a distância calculada pelo próprio sistema.
  if (a.logistics.mode !== 'NAO') {
    const cities = [a.city, ...a.servedCities.filter((c) => c !== a.city)];
    for (const c of cities) {
      const km = c === a.city ? 10 : roadKm(a.city, c);
      const value = a.logistics.valueCents;
      const priceCents =
        value === null
          ? null
          : a.logistics.mode === 'FIXO'
            ? value
            : km === null
              ? null
              : Math.round(km * 2 * value);
      await add('LOGISTICA', { name: shortCity(c), km, priceCents });
    }
  }

  // Maquininha: à vista até o número de vezes que aceita, com a taxa média (a pessoa confere).
  for (let n = 1; n <= a.maxInstallments; n++)
    await add('TAXA_MAQUINA', {
      name: n === 1 ? 'À vista' : `${n}X`,
      rateBps: SETUP_CARD_FEES_BPS[n] ?? null,
    });

  const taxRateBps = SETUP_TAX_BPS[a.taxRegime];
  await tx.quoteSettings.upsert({
    where: { companyId },
    create: {
      taxRateBps,
      logoDataUrl: a.logoDataUrl,
      defaultDeliveryDays: a.leadDays,
    },
    update: {
      ...(taxRateBps !== null ? { taxRateBps } : {}),
      ...(a.logoDataUrl ? { logoDataUrl: a.logoDataUrl } : {}),
      defaultDeliveryDays: a.leadDays,
      version: { increment: 1 },
    },
  });

  // Logística desligada para quem não faz retirada nem entrega (nada em andamento numa conta nova).
  if (a.logistics.mode === 'NAO') {
    const inFlight = await tx.pickupRequest.count({
      where: { status: { in: ['AGUARDANDO_AGENDAMENTO', 'AGENDADA', 'EM_EXECUCAO'] } },
    });
    if (inFlight === 0)
      await tx.moduleSetting.upsert({
        where: { companyId_key: { companyId, key: 'logistica' } },
        create: { key: 'logistica', enabled: false, updatedById: actor.userId },
        update: { enabled: false, updatedById: actor.userId, version: { increment: 1 } },
      });
  }

  const { logoDataUrl: _logo, ...answers } = a;
  const updated = await tx.companySettings.update({
    where: { id: companyId },
    data: {
      workingDays: [...new Set(a.workingDays)].sort(),
      workdayStart: a.workdayStart,
      workdayEnd: a.workdayEnd,
      arrivalWindowStart: addMinutes(a.workdayStart, -90),
      arrivalAlertAt: addMinutes(
        a.workdayStart,
        Math.min(60, Math.floor(minutesBetween(a.workdayStart, a.workdayEnd) / 2)),
      ),
      teamSize: a.teamSize,
      monthlyGoalCents: a.monthlyGoalCents,
      servesOnSite: a.onSite,
      ...(taxRateBps !== null ? { taxRateBps } : {}),
      setupAnswers: { ...answers, hasLogo: Boolean(a.logoDataUrl) } as Prisma.InputJsonValue,
      setupDoneAt: new Date(),
      updatedById: actor.userId,
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'company.setup',
    entityType: 'company_settings',
    entityId: String(companyId),
    summary: `Perguntas do primeiro acesso respondidas: ${created} itens criados na base do orçamento.`,
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.COMPANY_SETTINGS_UPDATED,
    aggregateType: 'company_settings',
    aggregateId: String(companyId),
    payload: {
      tradeName: updated.tradeName,
      timezone: updated.timezone,
      workdayStart: updated.workdayStart,
      arrivalAlertAt: updated.arrivalAlertAt,
      workdayEnd: updated.workdayEnd,
      arrivalWindowStart: updated.arrivalWindowStart,
      lateAlertMinutes: updated.lateAlertMinutes,
      version: updated.version,
    },
  });
  return { created };
}

export async function onboardingRoutes(app: FastifyInstance) {
  const { prisma, system, env, hashToken, storage } = app.ctx;

  async function state(userIsOwner: boolean, supportAgent: boolean): Promise<GettingStartedDto> {
    const company = await prisma.companySettings.findUniqueOrThrow({
      where: { id: requireCompanyId() },
      select: {
        gettingStartedHiddenAt: true,
        setupDoneAt: true,
        isDemo: true,
        isPlatform: true,
      },
    });
    const steps = gettingStartedSteps(await gettingStartedFacts(prisma));
    const help = await prisma.contactRequest.findFirst({
      where: { kind: 'AJUDA_COMECAR', status: 'PENDENTE' },
      orderBy: { createdAt: 'desc' },
      select: { preferredAt: true },
    });
    const regular = userIsOwner && !supportAgent && !company.isDemo && !company.isPlatform;
    return {
      show: regular && company.gettingStartedHiddenAt === null,
      askSetup: regular && company.setupDoneAt === null,
      steps,
      helpRequestedFor: help?.preferredAt.toISOString() ?? null,
    };
  }

  const isOwner = (perms: ReadonlySet<string>) => perms.has('empresa.configurar');

  app.get('/api/onboarding', { config: { access: WEB } }, async (request) => {
    const auth = request.auth!;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { supportAgent: true },
    });
    const s = await state(isOwner(auth.permissions), user.supportAgent);
    // Tudo feito: o cartão some sozinho, para sempre.
    if (s.show && s.steps.every((x) => x.done)) {
      await prisma.companySettings.update({
        where: { id: requireCompanyId() },
        data: { gettingStartedHiddenAt: new Date() },
      });
      return { ...s, show: false };
    }
    return s;
  });

  app.post('/api/onboarding/setup', { config: { access: OWNER } }, async (request) => {
    const input = setupAnswersSchema.parse(request.body);
    const actor = actorFrom(request);
    const result = await prisma.$transaction((tx) => applySetup(tx, actor, input));
    return { ok: true, created: result.created };
  });

  app.post('/api/onboarding/hide', { config: { access: OWNER } }, async (request) => {
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      await tx.companySettings.update({
        where: { id: requireCompanyId() },
        data: { gettingStartedHiddenAt: new Date() },
      });
      await audit(tx, actor, {
        action: 'company.getting_started_hidden',
        entityType: 'company_settings',
        entityId: String(requireCompanyId()),
        summary: 'Começo guiado escondido ("Já sei usar").',
      });
    });
    return { ok: true };
  });

  /** "Quero ajuda para começar" (item 6): cai no painel da plataforma e no e-mail do dono dela. */
  app.post('/api/onboarding/help', { config: { access: OWNER } }, async (request) => {
    const input = helpRequestSchema.parse(request.body);
    const preferredAt = new Date(input.preferredAt);
    if (preferredAt.getTime() < Date.now() - 3_600_000)
      throw Errors.business('Escolha um dia e um horário daqui para a frente.');
    const actor = actorFrom(request);
    const companyId = requireCompanyId();
    const [company, user] = await Promise.all([
      prisma.companySettings.findUniqueOrThrow({
        where: { id: companyId },
        select: { tradeName: true, phone: true },
      }),
      prisma.user.findUniqueOrThrow({
        where: { id: actor.userId! },
        select: { displayName: true, employee: { select: { phone: true } } },
      }),
    ]);
    const phone = user.employee?.phone ?? company.phone;
    await prisma.$transaction(async (tx) => {
      await tx.contactRequest.updateMany({
        where: { kind: 'AJUDA_COMECAR', status: 'PENDENTE' },
        data: { status: 'CANCELADO' },
      });
      await tx.contactRequest.create({
        data: {
          kind: 'AJUDA_COMECAR',
          name: user.displayName,
          phone,
          preferredAt,
          note: input.note || null,
          createdById: actor.userId,
        },
      });
      await audit(tx, actor, {
        action: 'company.help_requested',
        entityType: 'company_settings',
        entityId: String(companyId),
        summary: `Pediu ajuda para começar para ${preferredAt.toISOString()}.`,
      });
    });
    await notifyPlatformAdmins(system, {
      subject: `${company.tradeName} quer ajuda para começar`,
      title: `${company.tradeName} quer ajuda para começar`,
      paragraphs: [
        `${user.displayName} pediu uma conversa para ${preferredAt.toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          dateStyle: 'full',
          timeStyle: 'short',
        })}.`,
        `Telefone: ${phone ?? 'não informado'}.`,
        ...(input.note ? [`Recado: ${input.note}`] : []),
      ],
      url: `${webUrl(env)}/plataforma/empresas`,
      kind: 'plataforma-ajuda',
    });
    app.ctx.mailer.kick();
    return { ok: true };
  });

  // ---------------- explicação de cada tela (item 5)
  app.get('/api/me/tips', { config: { access: WEB } }, async (request) => {
    const rows = await prisma.userSeenTip.findMany({
      where: { userId: request.auth!.userId },
      select: { key: true },
    });
    return { seen: rows.map((r) => r.key) };
  });

  app.post('/api/me/tips/:key', { config: { access: WEB } }, async (request) => {
    const key = tipKeySchema.parse((request.params as { key?: string }).key);
    await prisma.userSeenTip.upsert({
      where: { userId_key: { userId: request.auth!.userId, key } },
      create: { userId: request.auth!.userId, key },
      update: {},
    });
    return { ok: true };
  });

  // ---------------- funcionário termina o cadastro pelo link (item 4)
  app.post(
    '/api/employees/:id/invite',
    { config: { access: MANAGE_EMPLOYEES } },
    async (request): Promise<EmployeeInviteDto> => {
      const { id } = idParams.parse(request.params);
      const actor = actorFrom(request);
      const token = randomToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      const { employee, company } = await prisma.$transaction(async (tx) => {
        const employee = await tx.employee.findUnique({
          where: { id },
          select: { id: true, displayName: true, phone: true, active: true },
        });
        if (!employee || !employee.active) throw Errors.notFound('Funcionário');
        await tx.employeeInvite.updateMany({
          where: { employeeId: id, usedAt: null },
          data: { usedAt: new Date() },
        });
        await tx.employeeInvite.create({
          data: {
            employeeId: id,
            tokenHash: hashToken(token),
            expiresAt,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'employee.invite_created',
          entityType: 'employee',
          entityId: id,
          summary: `Link de cadastro enviado para ${employee.displayName}.`,
        });
        const company = await tx.companySettings.findUniqueOrThrow({
          where: { id: requireCompanyId() },
          select: { tradeName: true },
        });
        return { employee, company };
      });
      const url = `${webUrl(env)}/convite/${encodeURIComponent(token)}`;
      const first = employee.displayName.split(/\s+/)[0];
      return {
        url,
        whatsappUrl: employee.phone
          ? whatsappLink(
              employee.phone,
              `Oi, ${first}! Este é o link para você terminar o seu cadastro na ${company.tradeName}: coloque a sua foto e crie o PIN que você vai usar no tablet da oficina. ${url}`,
            )
          : null,
        expiresAt: expiresAt.toISOString(),
      };
    },
  );

  async function inviteFor(token: string) {
    const invite = await system.employeeInvite.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        companyId: true,
        employeeId: true,
        usedAt: true,
        expiresAt: true,
      },
    });
    if (!invite) throw Errors.notFound('Convite');
    return invite;
  }
  const tokenParam = z.object({ token: z.string().min(20).max(100) });

  app.get(
    '/api/public/convite/:token',
    { config: { access: { public: true } } },
    async (request, reply): Promise<PublicInviteDto> => {
      void reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow');
      const { token } = tokenParam.parse(request.params);
      const invite = await inviteFor(token);
      return runAsCompany(invite.companyId, async () => {
        const [employee, company] = await Promise.all([
          prisma.employee.findUniqueOrThrow({
            where: { id: invite.employeeId },
            select: { displayName: true, jobTitle: true, photoFileId: true, active: true },
          }),
          prisma.companySettings.findUniqueOrThrow({
            where: { id: invite.companyId },
            select: { tradeName: true },
          }),
        ]);
        return {
          companyName: company.tradeName,
          employeeName: employee.displayName,
          jobTitle: employee.jobTitle,
          hasPhoto: employee.photoFileId !== null,
          valid: !invite.usedAt && invite.expiresAt > new Date() && employee.active,
        };
      });
    },
  );

  /** A pessoa põe a própria foto pelo link (antes de criar o PIN). */
  app.post(
    '/api/public/convite/:token/foto',
    { config: { access: { public: true } } },
    async (request) => {
      const { token } = tokenParam.parse(request.params);
      const invite = await inviteFor(token);
      if (invite.usedAt || invite.expiresAt <= new Date())
        throw Errors.business('Este link já foi usado ou venceu. Peça um novo para o seu gestor.');
      if (!request.isMultipart())
        throw Errors.unsupportedMedia('Envie a foto como multipart/form-data.');
      const file = await request.file({
        limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
      });
      if (!file) throw Errors.validation(undefined, 'Nenhum arquivo enviado.');
      const data = await file.toBuffer().catch((error: unknown) => {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
          throw Errors.payloadTooLarge(`A foto deve ter no máximo ${env.MAX_UPLOAD_MB} MB.`);
        throw error;
      });
      const mime = sniffImageType(data);
      if (!mime) throw Errors.unsupportedMedia('Envie a foto em JPG, PNG ou WebP.');
      const image = await processImage(data, mime, 1024);
      const fileId = randomUUID();
      const storageKey = `employee-photo/${fileId}`;
      await storage.put(storageKey, image.data);
      const actor: ActorContext = {
        userId: null,
        sessionId: null,
        ip: request.ip,
        requestId: null,
      };
      try {
        const old = await runAsCompany(invite.companyId, () =>
          prisma.$transaction(async (tx) => {
            const before = await tx.employee.findUniqueOrThrow({
              where: { id: invite.employeeId },
            });
            await tx.storedFile.create({
              data: {
                id: fileId,
                storageKey,
                purpose: 'employee-photo',
                originalName: (file.filename || 'foto').slice(0, 200),
                mimeType: image.mime,
                sizeBytes: image.data.length,
                sha256: sha256Hex(image.data),
                uploadedById: null,
                processedAt: new Date(),
                width: image.width,
                height: image.height,
                originalSizeBytes: data.length,
              },
            });
            const updated = await tx.employee.update({
              where: { id: invite.employeeId },
              data: { photoFileId: fileId, version: { increment: 1 } },
            });
            const oldFile = before.photoFileId
              ? await tx.storedFile.update({
                  where: { id: before.photoFileId },
                  data: { deletedAt: new Date() },
                })
              : null;
            await audit(tx, actor, {
              action: 'employee.photo_updated',
              entityType: 'employee',
              entityId: updated.id,
              summary: `${updated.displayName} pôs a própria foto pelo link de cadastro.`,
            });
            await appendEvent(tx, actor, {
              type: EVENT_TYPES.EMPLOYEE_UPDATED,
              aggregateType: 'employee',
              aggregateId: updated.id,
              payload: employeeEventPayload(updated),
            });
            return oldFile;
          }),
        );
        if (old) await storage.remove(old.storageKey).catch(() => undefined);
      } catch (error) {
        await storage.remove(storageKey).catch(() => undefined);
        throw error;
      }
      return { ok: true };
    },
  );

  app.post(
    '/api/public/convite/:token',
    { config: { access: { public: true } } },
    async (request) => {
      const { token } = tokenParam.parse(request.params);
      const { pin } = acceptInviteSchema.parse(request.body);
      const invite = await inviteFor(token);
      if (invite.usedAt || invite.expiresAt <= new Date())
        throw Errors.business('Este link já foi usado ou venceu. Peça um novo para o seu gestor.');
      const pinHash = await hashSecret(pin);
      const actor: ActorContext = {
        userId: null,
        sessionId: null,
        ip: request.ip,
        requestId: null,
      };
      await runAsCompany(invite.companyId, () =>
        prisma.$transaction(async (tx) => {
          const used = await tx.employeeInvite.updateMany({
            where: { id: invite.id, usedAt: null },
            data: { usedAt: new Date() },
          });
          if (used.count === 0) throw Errors.business('Este link já foi usado.');
          const employee = await tx.employee.update({
            where: { id: invite.employeeId },
            data: { version: { increment: 1 } },
          });
          await tx.user.update({
            where: { id: employee.userId },
            data: { pinHash, credentialsChangedAt: new Date() },
          });
          await audit(tx, actor, {
            action: 'employee.invite_accepted',
            entityType: 'employee',
            entityId: employee.id,
            summary: `${employee.displayName} terminou o cadastro pelo link (PIN do tablet criado).`,
          });
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.EMPLOYEE_UPDATED,
            aggregateType: 'employee',
            aggregateId: employee.id,
            payload: employeeEventPayload(employee),
          });
        }),
      );
      return { ok: true };
    },
  );
}

/** E-mail para quem cuida do painel da plataforma (sem e-mail configurado, nada sai). */
export async function notifyPlatformAdmins(
  system: PrismaClient,
  m: {
    subject: string;
    title: string;
    paragraphs: string[];
    url: string;
    kind: string;
    /** Item 43: também no celular (padrão: a primeira frase); `false` = só o e-mail. */
    push?: string | false;
  },
) {
  const admins = await system.platformAdmin.findMany({
    where: { active: true },
    select: { email: true },
  });
  if (admins.length === 0) return;
  const body = simpleEmail({
    title: m.title,
    paragraphs: m.paragraphs,
    button: { label: 'Abrir o painel', url: m.url },
  });
  await runAsCompany(PLATFORM_RECORD_ID, () =>
    system.$transaction(async (tx) => {
      // Os e-mails ficam na fila da empresa da plataforma.
      await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_RECORD_ID)}, true)`;
      for (const a of admins)
        await enqueueEmail(tx, { to: a.email, subject: m.subject, kind: m.kind, ...body });
    }),
  );
  if (m.push !== false) {
    let path = '/plataforma';
    try {
      path = new URL(m.url).pathname;
    } catch {
      /* fica o Início do painel */
    }
    await pushPlatformAdmins(system, m.url, {
      title: m.title,
      body: m.push ?? m.paragraphs[0] ?? '',
      url: path,
      tag: m.kind,
    }).catch(() => 0);
  }
}
