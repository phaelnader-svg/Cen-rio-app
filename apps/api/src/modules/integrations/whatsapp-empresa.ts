/**
 * WhatsApp da empresa no painel do Cenário (Escritório): o dono liga o número que já usa no
 * aplicativo WhatsApp Business (coexistência: o app continua funcionando no celular), escolhe o
 * número se a Meta trouxer mais de um e desliga. Cada empresa liga o próprio número; o webhook
 * acha a empresa pelo número que recebeu a mensagem.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { actorFrom } from '../../core/audit';
import { Errors } from '../../lib/errors';
import {
  PAINEL_STATE,
  WA_MANAGE,
  connectWhatsappNumber,
  connectionOf,
  disconnectConnection,
} from './connections';
import { type MetaAccounts, authorizeUrl } from './meta';
import { missingEnv, providerDef } from './registry';

export async function whatsappEmpresaRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const def = () => providerDef('WHATSAPP')!;

  app.get('/api/v1/whatsapp-empresa', { config: { access: WA_MANAGE } }, async () => {
    const c = await connectionOf(prisma, 'WHATSAPP');
    const pending = c?.status === 'PENDENTE' ? (c.config.pendingAccounts as MetaAccounts) : null;
    return {
      // Servidor ligado à Meta (app, chave e configuração do cadastro). Sem isso o botão espera.
      ready: missingEnv(def()).length === 0 && Boolean(process.env.META_WA_CONFIG_ID),
      status: c?.status ?? 'DESCONECTADA',
      test: c?.mode === 'TESTE_LOCAL',
      display: (c?.config.display as string | undefined) ?? null,
      label: c?.accountLabel ?? null,
      since: c?.lastSyncAt?.toISOString() ?? null,
      error: c?.status === 'ERRO' ? c.lastError : null,
      choices: pending
        ? pending.wabas.flatMap((w) =>
            w.phones.map((ph) => ({ id: ph.id, display: ph.display, name: ph.name })),
          )
        : [],
    };
  });

  app.post(
    '/api/v1/whatsapp-empresa/conectar',
    { config: { access: WA_MANAGE } },
    async (request) => {
      const missing = missingEnv(def());
      if (missing.length || !process.env.META_WA_CONFIG_ID)
        throw Errors.business(
          'A ligação com o WhatsApp ainda está sendo preparada. Tente de novo mais tarde.',
        );
      const state = `${PAINEL_STATE}${randomBytes(24).toString('base64url')}`;
      await prisma.integrationOAuthState.create({
        data: { state, providerKey: 'WHATSAPP', userId: actorFrom(request).userId! },
      });
      return { authorizeUrl: authorizeUrl(def().scopes, state, true) };
    },
  );

  app.post(
    '/api/v1/whatsapp-empresa/escolher',
    { config: { access: WA_MANAGE } },
    async (request) => {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.body);
      const c = await connectionOf(prisma, 'WHATSAPP');
      const acc = c?.config.pendingAccounts as MetaAccounts | undefined;
      const hit = acc?.wabas
        .flatMap((w) => w.phones.map((ph) => ({ w, ph })))
        .find((x) => x.ph.id === id);
      if (!c || !hit) throw Errors.business('Número não encontrado. Clique em Conectar de novo.');
      await connectWhatsappNumber(
        prisma,
        app.ctx.system,
        actorFrom(request),
        hit.ph,
        hit.w,
        c.secret?.userToken as string | undefined,
      );
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/whatsapp-empresa/desligar',
    { config: { access: WA_MANAGE } },
    async (request) => {
      await disconnectConnection(prisma, actorFrom(request), 'WHATSAPP');
      return { ok: true };
    },
  );
}
