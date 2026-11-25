import {
  LEGAL,
  PRIVACY_REQUEST_KIND_LABEL,
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUESTER_KIND_LABEL,
  PRIVACY_RESPONSE_DAYS,
  privacyProtocol,
  privacyRequestAccountSchema,
  privacyRequestPublicSchema,
  type PrivacyRequestDto,
  type PrivacyRequestKind,
  type PrivacyRequestStatus,
  type PrivacyRequesterKind,
} from '@cenario/shared';
import type { Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { captchaFailed } from '../../core/captcha';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { PLATFORM_COMPANY_ID, requireCompanyId, runAsCompany } from '../../core/tenant';
import { AuthThrottle, clientIpKey } from '../../core/throttle';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';

/**
 * LGPD (2026-11-25): pedidos sobre dados pessoais (art. 18). Quem pede recebe um protocolo e o
 * prazo; o encarregado de dados recebe um e-mail. NADA é apagado sozinho: o pedido fica
 * registrado e o encarregado atende (a exclusão de uma empresa passa antes pela cópia dos dados e
 * pelo que a lei manda guardar, como notas e registros de acesso).
 */

const DAY_MS = 86_400_000;
/** Pedidos públicos por IP: 5 por hora (cada envio conta). */
const PUBLIC_POLICY = {
  maxFailures: 5,
  windowSeconds: 3600,
  baseLockSeconds: 3600,
  maxLockSeconds: 3600,
};

/** Teto global: 100 pedidos públicos por hora. */
const PUBLIC_GLOBAL_POLICY = {
  maxFailures: 100,
  windowSeconds: 3600,
  baseLockSeconds: 900,
  maxLockSeconds: 3600,
};

const fmtDate = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

export async function privacyRoutes(app: FastifyInstance) {
  const { prisma, system, env, mailer } = app.ctx;
  const throttle = new AuthThrottle(system);
  const webUrl = () => (env.PUBLIC_WEB_URL || env.ALLOWED_ORIGINS[0] || '').replace(/\/$/, '');

  /** Para onde vão os avisos: o e-mail do encarregado; sem ele, o e-mail da empresa da plataforma. */
  async function officerEmail(): Promise<string | null> {
    if (LEGAL.emailPrivacidade) return LEGAL.emailPrivacidade;
    const c = await system.companySettings.findUnique({
      where: { id: PLATFORM_COMPANY_ID },
      select: { email: true },
    });
    return c?.email ?? null;
  }

  async function notify(
    tx: Tx,
    row: { id: string; name: string; email: string; dueAt: Date },
    details: string[],
    kind: PrivacyRequestKind,
  ) {
    const protocol = privacyProtocol(row.id);
    const to = await officerEmail();
    if (to)
      await enqueueEmail(tx, {
        to,
        kind: 'lgpd-pedido-encarregado',
        subject: `Pedido sobre dados pessoais ${protocol}: ${PRIVACY_REQUEST_KIND_LABEL[kind]}`,
        ...simpleEmail({
          title: `Novo pedido sobre dados pessoais (${protocol})`,
          paragraphs: [
            ...details,
            `Prazo para responder: ${fmtDate(row.dueAt)} (até ${PRIVACY_RESPONSE_DAYS} dias, LGPD art. 19).`,
            'Nada foi apagado. Confira quem pediu, responda pelo e-mail da pessoa e marque o andamento na tela Empresas do painel.',
          ],
          button: { label: 'Abrir a tela Empresas', url: `${webUrl()}/painel/empresas` },
        }),
      });
    await enqueueEmail(tx, {
      to: row.email,
      kind: 'lgpd-pedido-recebido',
      subject: `Recebemos o seu pedido sobre dados pessoais (protocolo ${protocol})`,
      ...simpleEmail({
        title: 'Recebemos o seu pedido',
        paragraphs: [
          `Olá, ${row.name}. O seu pedido "${PRIVACY_REQUEST_KIND_LABEL[kind]}" foi registrado com o protocolo ${protocol}.`,
          `Vamos responder neste e-mail até ${fmtDate(row.dueAt)}. Se precisarmos confirmar que é você mesmo, a gente avisa antes de fazer qualquer mudança.`,
          'Se não foi você que pediu, é só ignorar esta mensagem.',
        ],
      }),
    });
  }

  /** Página pública /privacidade/pedido (sem login). */
  app.post(
    '/api/v1/privacy/requests',
    { config: { access: { public: true } } },
    async (request, reply) => {
      const input = privacyRequestPublicSchema.parse(request.body);
      const ipKey = clientIpKey(request, 'privacy-ip');
      await throttle.assertAllowed([ipKey, 'privacy:global']);
      if (input.website) throw captchaFailed();
      if (app.ctx.captcha && !(await app.ctx.captcha(input.captcha, request.ip)))
        throw captchaFailed();
      await throttle.registerFailure(ipKey, PUBLIC_POLICY);
      // Teto do sistema inteiro (vale também quando o IP real é desconhecido).
      await throttle.registerFailure('privacy:global', PUBLIC_GLOBAL_POLICY);
      const dueAt = new Date(Date.now() + PRIVACY_RESPONSE_DAYS * DAY_MS);
      const row = await runAsCompany(PLATFORM_COMPANY_ID, () =>
        prisma.$transaction(async (tx) => {
          const r = await tx.privacyRequest.create({
            data: {
              scope: 'PUBLICO',
              kind: input.kind,
              requester: input.requester,
              name: input.name,
              email: input.email,
              companyName: input.company || null,
              message: input.message || null,
              dueAt,
            },
          });
          await audit(tx, actorFrom(request), {
            action: 'privacy.requested',
            entityType: 'privacy_request',
            entityId: r.id,
            summary: `Pedido sobre dados pessoais pela página pública (${PRIVACY_REQUEST_KIND_LABEL[input.kind]}), protocolo ${privacyProtocol(r.id)}.`,
          });
          await notify(
            tx,
            r,
            [
              `Pedido: ${PRIVACY_REQUEST_KIND_LABEL[input.kind]}.`,
              `Quem pediu: ${input.name} <${input.email}>.`,
              `Quem é: ${PRIVACY_REQUESTER_KIND_LABEL[input.requester]}.`,
              ...(input.company ? [`Tapeçaria citada: ${input.company}.`] : []),
              ...(input.message ? [`Mensagem: ${input.message}`] : []),
            ],
            input.kind,
          );
          return r;
        }),
      );
      mailer.kick();
      return reply.status(201).send({
        protocol: privacyProtocol(row.id),
        dueAt: row.dueAt.toISOString(),
      });
    },
  );

  /** De dentro do painel: a pessoa logada pede sobre os próprios dados (ou o gestor, da empresa). */
  app.post(
    '/api/v1/privacy/my-request',
    { config: { access: { session: 'WEB', billingExempt: true } } },
    async (request, reply) => {
      const input = privacyRequestAccountSchema.parse(request.body);
      if (input.scope === 'EMPRESA' && !request.auth!.permissions.has('empresa.configurar'))
        throw Errors.forbidden('Só o gestor pode pedir pela empresa inteira.');
      const companyId = requireCompanyId();
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: request.auth!.userId! },
        select: { id: true, displayName: true, email: true },
      });
      if (!user.email) throw Errors.business('Sua conta não tem e-mail para receber a resposta.');
      const company = await prisma.companySettings.findUniqueOrThrow({
        where: { id: companyId },
        select: { tradeName: true },
      });
      const dueAt = new Date(Date.now() + PRIVACY_RESPONSE_DAYS * DAY_MS);
      const row = await prisma.$transaction(async (tx) => {
        const r = await tx.privacyRequest.create({
          data: {
            userId: user.id,
            scope: input.scope,
            kind: input.kind,
            name: user.displayName,
            email: user.email!,
            companyName: company.tradeName,
            message: input.message || null,
            dueAt,
          },
        });
        await audit(tx, actorFrom(request), {
          action: 'privacy.requested',
          entityType: 'privacy_request',
          entityId: r.id,
          summary: `${user.displayName} pediu "${PRIVACY_REQUEST_KIND_LABEL[input.kind]}" (${input.scope === 'EMPRESA' ? 'empresa inteira' : 'só a própria conta'}), protocolo ${privacyProtocol(r.id)}. Nada foi apagado.`,
        });
        await notify(
          tx,
          { ...r, name: user.displayName, email: user.email! },
          [
            `Pedido: ${PRIVACY_REQUEST_KIND_LABEL[input.kind]} (${input.scope === 'EMPRESA' ? 'a empresa inteira' : 'só a conta da pessoa'}).`,
            `Empresa: ${company.tradeName} (nº ${companyId}).`,
            `Quem pediu (logado): ${user.displayName} <${user.email}>.`,
            ...(input.message ? [`Mensagem: ${input.message}`] : []),
          ],
          input.kind,
        );
        return r;
      });
      mailer.kick();
      return reply.status(201).send({
        protocol: privacyProtocol(row.id),
        dueAt: row.dueAt.toISOString(),
      });
    },
  );

  // ───────────── Dono da plataforma: todos os pedidos (banco do sistema) ─────────────
  const PLATFORM = { session: 'WEB', permissions: ['empresa.configurar'] } as const;
  function assertPlatformOwner(request: FastifyRequest) {
    if (request.auth?.companyId !== PLATFORM_COMPANY_ID || request.auth.kind !== 'WEB')
      throw Errors.notFound('Página');
  }

  app.get(
    '/api/v1/platform/privacy-requests',
    { config: { access: PLATFORM } },
    async (request) => {
      assertPlatformOwner(request);
      const rows = await system.privacyRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { company: { select: { tradeName: true } } },
      });
      return {
        items: rows.map(
          (r): PrivacyRequestDto => ({
            id: r.id,
            protocol: privacyProtocol(r.id),
            companyId: r.companyId,
            companyName: r.scope === 'PUBLICO' ? null : r.company.tradeName,
            scope: r.scope as PrivacyRequestDto['scope'],
            kind: r.kind as PrivacyRequestKind,
            requester: (r.requester as PrivacyRequesterKind | null) ?? null,
            name: r.name,
            email: r.email,
            company: r.companyName,
            message: r.message,
            status: r.status as PrivacyRequestStatus,
            createdAt: r.createdAt.toISOString(),
            dueAt: r.dueAt.toISOString(),
          }),
        ),
      };
    },
  );

  app.post(
    '/api/v1/platform/privacy-requests/:id/status',
    { config: { access: PLATFORM } },
    async (request) => {
      assertPlatformOwner(request);
      const { id } = idParams.parse(request.params);
      const { status } = z.object({ status: z.enum(PRIVACY_REQUEST_STATUSES) }).parse(request.body);
      const r = await system.privacyRequest.update({ where: { id }, data: { status } });
      await prisma.$transaction((tx) =>
        audit(tx, actorFrom(request), {
          action: 'privacy.status',
          entityType: 'privacy_request',
          entityId: r.id,
          summary: `Pedido sobre dados ${privacyProtocol(r.id)} marcado como ${status}.`,
        }),
      );
      return { id: r.id, status: r.status };
    },
  );
}
