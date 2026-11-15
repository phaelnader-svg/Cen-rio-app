/**
 * Central de Conexões: estado real de cada conexão, autorização oficial (OAuth da Meta),
 * escolha da conta da Cenário, teste, reconexão, desconexão e modo de teste local.
 * Segredos ficam cifrados no servidor; o navegador só recebe estado e rótulos.
 */
import { EVENT_TYPES, anyPermissionAudience } from '@cenario/shared';
import type { IntegrationConnection, Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import {
  type MetaAccounts,
  authorizeUrl,
  discoverAccounts,
  exchangeCode,
  testConnection,
} from './meta';
import {
  PROVIDERS,
  type ProviderDef,
  missingEnv,
  openSecret,
  providerDef,
  sealSecret,
  testModeAllowed,
} from './registry';

export const CONN_VIEW = { session: 'WEB', permissions: ['jogo.acessar'] } as const;
export const CONN_MANAGE = {
  session: 'WEB',
  permissions: ['jogo.acessar', 'conexoes.gerenciar'],
} as const;
const AUDIENCE = anyPermissionAudience('conexoes.gerenciar', 'jogo.acessar');
const keyParams = z.object({ key: z.string().regex(/^[A-Z_]{2,40}$/) });

export async function connectionOf(db: Tx | PrismaClient, key: string) {
  const c = await db.integrationConnection.findUnique({ where: { providerKey: key } });
  if (!c) return null;
  return {
    ...c,
    config: (c.config ?? {}) as Record<string, unknown>,
    secret: openSecret(c.secretEnc),
  };
}

/** Conexão utilizável (conectada, real ou teste) ou erro com o que falta. */
export async function requireConnection(db: Tx | PrismaClient, key: string) {
  const c = await connectionOf(db, key);
  if (!c || c.status !== 'CONECTADA') {
    const p = providerDef(key);
    throw Errors.business(
      `${p?.label ?? key} não está conectado. Abra a Central de Conexões no escritório.`,
      { provider: key },
    );
  }
  return c;
}

async function upsert(
  tx: Tx,
  actor: ActorContext,
  key: string,
  data: Partial<Omit<IntegrationConnection, 'config'>> & {
    config?: unknown;
    secret?: Record<string, unknown> | null;
  },
) {
  const { secret, ...rest } = data;
  const payload = {
    ...rest,
    ...(secret !== undefined ? { secretEnc: secret ? sealSecret(secret) : null } : {}),
    config: (rest.config ?? undefined) as Prisma.InputJsonValue | undefined,
    connectedById: actor.userId,
  };
  const row = await tx.integrationConnection.upsert({
    where: { providerKey: key },
    create: {
      providerKey: key,
      ...payload,
      config: (payload.config ?? {}) as Prisma.InputJsonValue,
    },
    update: { ...payload, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'connection.changed',
    entityType: 'integration_connection',
    entityId: row.id,
    summary: `${providerDef(key)?.label ?? key}: ${row.status}${row.mode === 'TESTE_LOCAL' ? ' (teste local)' : ''}${row.accountLabel ? ` · ${row.accountLabel}` : ''}.`,
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.CONNECTION_CHANGED,
    aggregateType: 'integration_connection',
    aggregateId: row.id,
    payload: { key },
    audience: AUDIENCE,
  });
  return row;
}

const TEST_ACCOUNTS: Record<
  string,
  { label: string; accountId: string; config: Record<string, unknown> }
> = {
  WHATSAPP: {
    label: 'Número de teste +55 12 90000-0000 (simulado)',
    accountId: 'waba-teste',
    config: { phoneNumberId: 'pn-teste', display: '+55 12 90000-0000', coexistence: true },
  },
  INSTAGRAM: {
    label: '@cenario.teste (simulado)',
    accountId: 'ig-teste',
    config: { instagramId: 'ig-teste', pageId: 'page-teste' },
  },
  MESSENGER: {
    label: 'Página Cenário Teste (simulada)',
    accountId: 'page-teste',
    config: { pageId: 'page-teste' },
  },
  META_ADS: {
    label: 'Conta de anúncios de teste (simulada)',
    accountId: 'act_teste',
    config: { adAccountId: 'act_teste' },
  },
  ASSINATURA: { label: 'Clicksign — teste local', accountId: 'clicksign-teste', config: {} },
  FISCAL: { label: 'Emissor de teste (homologação local)', accountId: 'fiscal-teste', config: {} },
  COBRANCAS: { label: 'Asaas — teste local', accountId: 'asaas-teste', config: {} },
  BANCO_PJ: { label: 'Conta PJ de teste', accountId: 'banco-teste', config: {} },
};

function card(
  p: ProviderDef,
  c: Awaited<ReturnType<typeof connectionOf>>,
  extra: Record<string, unknown> = {},
) {
  const missing = missingEnv(p);
  const accounts = (c?.config.pendingAccounts as MetaAccounts | undefined) ?? null;
  return {
    key: p.key,
    label: p.label,
    group: p.group,
    provider: p.provider,
    auth: p.auth,
    capabilities: p.capabilities,
    scopes: p.scopes,
    status:
      p.auth === 'SESSAO'
        ? 'CONECTADA'
        : p.auth === 'PLANEJADA'
          ? 'PLANEJADA'
          : (c?.status ?? 'DESCONECTADA'),
    mode: c?.mode ?? null,
    accountLabel: c?.accountLabel ?? null,
    lastSyncAt: c?.lastSyncAt?.toISOString() ?? null,
    lastError: c?.lastError ?? null,
    missing: p.auth === 'META_OAUTH' || p.auth === 'API_KEY' ? missing : [],
    external: p.external,
    docsUrl: p.docsUrl,
    testModeAvailable: p.testMode && testModeAllowed(),
    pendingAccounts: accounts
      ? {
          pages: accounts.pages.map((x) => ({
            id: x.id,
            name: x.name,
            instagram: x.instagram ?? null,
          })),
          wabas: accounts.wabas,
          adAccounts: accounts.adAccounts,
        }
      : null,
    ...extra,
  };
}

export async function connectionRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/connections', { config: { access: CONN_VIEW } }, async (request) => {
    const rows = await prisma.integrationConnection.findMany();
    const company = await prisma.companySettings.findUnique({ where: { id: 1 } });
    const me = await prisma.user.findUnique({
      where: { id: request.auth!.userId! },
      select: { displayName: true, email: true },
    });
    return PROVIDERS.map((p) => {
      const row = rows.find((r) => r.providerKey === p.key);
      const c = row
        ? { ...row, config: (row.config ?? {}) as Record<string, unknown>, secret: null }
        : null;
      return card(
        p,
        c,
        p.key === 'CENARIO'
          ? {
              accountLabel: company?.tradeName || company?.legalName || 'Cenário Estofados',
              company: {
                name: company?.tradeName || company?.legalName || null,
                document: company?.document ?? null,
              },
              user: me,
              permissions: [...request.auth!.permissions].length,
              lastSyncAt: new Date().toISOString(),
            }
          : {},
      );
    });
  });

  /** Início da autorização oficial (Meta) ou registro de chave de API (provedores com API). */
  app.post(
    '/api/v1/connections/:key/connect',
    { config: { access: CONN_MANAGE } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const p = providerDef(key);
      if (!p || p.auth === 'SESSAO' || p.auth === 'PLANEJADA')
        throw Errors.business('Esta conexão não usa autorização externa.');
      const body = z
        .object({ apiKey: z.string().trim().min(10).max(500).optional() })
        .parse(request.body ?? {});
      const actor = actorFrom(request);
      if (p.auth === 'META_OAUTH') {
        const missing = missingEnv(p);
        if (missing.length)
          throw Errors.business(
            `Falta configurar no servidor: ${missing.map((m) => `${m.name} (${m.what})`).join('; ')}.`,
            { missing },
          );
        const state = randomBytes(24).toString('base64url');
        await prisma.integrationOAuthState.create({
          data: { state, providerKey: key, userId: actor.userId! },
        });
        return { authorizeUrl: authorizeUrl(p.scopes, state, key === 'WHATSAPP') };
      }
      // Provedores com chave de API: a chave vem do servidor (variável) ou do formulário, cifrada.
      const envKey = p.env[0] ? process.env[p.env[0].name] : undefined;
      const apiKey = body.apiKey ?? envKey;
      if (!apiKey && p.auth === 'API_KEY')
        throw Errors.business(
          `Informe a chave de API ou configure ${p.env.map((e) => e.name).join(', ')} no servidor.`,
          { missing: missingEnv(p) },
        );
      await prisma.$transaction((tx) =>
        upsert(tx, actor, key, {
          status: 'CONECTADA',
          mode: 'PRODUCAO',
          accountLabel: p.provider,
          secret: apiKey ? { apiKey } : null,
          lastError: null,
          lastSyncAt: new Date(),
        }),
      );
      return { ok: true };
    },
  );

  /** Retorno do OAuth da Meta: troca o código, descobre as contas e pede a escolha da conta da Cenário. */
  app.get(
    '/api/v1/connections/meta/callback',
    { config: { access: CONN_MANAGE } },
    async (request, reply) => {
      const q = z
        .object({
          code: z.string().optional(),
          state: z.string(),
          error_description: z.string().optional(),
        })
        .parse(request.query);
      const st = await prisma.integrationOAuthState.findUnique({ where: { state: q.state } });
      if (
        !st ||
        st.usedAt ||
        st.userId !== request.auth!.userId ||
        Date.now() - st.createdAt.getTime() > 15 * 60_000
      )
        throw Errors.forbidden(
          'Autorização expirada ou de outra sessão. Clique em Conectar de novo.',
        );
      await prisma.integrationOAuthState.update({
        where: { state: q.state },
        data: { usedAt: new Date() },
      });
      const actor = actorFrom(request);
      if (!q.code) {
        await prisma.$transaction((tx) =>
          upsert(tx, actor, st.providerKey, {
            status: 'ERRO',
            lastError: q.error_description ?? 'Autorização cancelada na Meta.',
          }),
        );
        return reply.redirect(`/jogo?central=${st.providerKey}`);
      }
      try {
        const token = await exchangeCode(q.code);
        const accounts = await discoverAccounts(token.access_token);
        await prisma.$transaction((tx) =>
          upsert(tx, actor, st.providerKey, {
            status: 'PENDENTE',
            mode: 'PRODUCAO',
            secret: { userToken: token.access_token },
            config: {
              pendingAccounts: accounts,
              tokenExpiresAt: token.expires_in
                ? new Date(Date.now() + token.expires_in * 1000).toISOString()
                : null,
            },
            lastError: null,
          }),
        );
      } catch (e) {
        await prisma.$transaction((tx) =>
          upsert(tx, actor, st.providerKey, {
            status: 'ERRO',
            lastError: (e as Error).message.slice(0, 900),
          }),
        );
      }
      return reply.redirect(`/jogo?central=${st.providerKey}`);
    },
  );

  /** Escolha da conta da Cenário (página, número do WhatsApp, Instagram ou conta de anúncios). */
  app.post(
    '/api/v1/connections/:key/select-account',
    { config: { access: CONN_MANAGE } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const body = z.object({ id: z.string().min(1).max(100) }).parse(request.body);
      const c = await connectionOf(prisma, key);
      const acc = c?.config.pendingAccounts as MetaAccounts | undefined;
      if (!c || !acc) throw Errors.business('Nenhuma autorização pendente. Clique em Conectar.');
      const page = acc.pages.find((p) => p.id === body.id || p.instagram?.id === body.id);
      const phone = acc.wabas
        .flatMap((w) => w.phones.map((ph) => ({ w, ph })))
        .find((x) => x.ph.id === body.id);
      const ad = acc.adAccounts.find((a) => a.id === body.id);
      let data: Parameters<typeof upsert>[3];
      if (key === 'WHATSAPP' && phone)
        data = {
          accountId: phone.w.id,
          accountLabel: `${phone.ph.display} · ${phone.ph.name}`,
          config: { phoneNumberId: phone.ph.id, wabaId: phone.w.id, display: phone.ph.display },
        };
      else if ((key === 'INSTAGRAM' || key === 'MESSENGER') && page)
        data = {
          accountId: key === 'INSTAGRAM' ? (page.instagram?.id ?? page.id) : page.id,
          accountLabel:
            key === 'INSTAGRAM'
              ? `@${page.instagram?.username ?? '?'} (página ${page.name})`
              : page.name,
          config: { pageId: page.id, instagramId: page.instagram?.id ?? null },
          secret: { userToken: c.secret?.userToken, pageToken: page.accessToken },
        };
      else if (key === 'META_ADS' && ad)
        data = { accountId: ad.id, accountLabel: ad.name, config: { adAccountId: ad.id } };
      else throw Errors.validation(undefined, 'Conta não encontrada na autorização.');
      if (key === 'INSTAGRAM' && !page?.instagram)
        throw Errors.business('Esta página não tem conta profissional do Instagram ligada.');
      await prisma.$transaction((tx) =>
        upsert(tx, actorFrom(request), key, {
          ...data,
          status: 'CONECTADA',
          lastSyncAt: new Date(),
          lastError: null,
        }),
      );
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/connections/:key/test',
    { config: { access: CONN_MANAGE } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const c = await connectionOf(prisma, key);
      if (!c || c.status === 'DESCONECTADA') throw Errors.business('Conexão desligada.');
      let result: { ok: boolean; detail: string };
      try {
        result = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'META_ADS'].includes(key)
          ? await testConnection({
              providerKey: key,
              mode: c.mode,
              config: c.config,
              secret: c.secret as never,
            })
          : {
              ok: true,
              detail:
                c.mode === 'TESTE_LOCAL'
                  ? 'Modo de teste local ativo.'
                  : 'Chave registrada no servidor.',
            };
      } catch (e) {
        result = { ok: false, detail: (e as Error).message };
      }
      await prisma.integrationConnection.update({
        where: { providerKey: key },
        data: {
          lastSyncAt: new Date(),
          lastError: result.ok ? null : result.detail.slice(0, 900),
          status: result.ok ? c.status : 'ERRO',
        },
      });
      return result;
    },
  );

  app.post(
    '/api/v1/connections/:key/disconnect',
    { config: { access: CONN_MANAGE } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      await prisma.$transaction((tx) =>
        upsert(tx, actorFrom(request), key, {
          status: 'DESCONECTADA',
          secret: null,
          accountLabel: null,
          accountId: null,
          config: {},
          lastError: null,
        }),
      );
      return { ok: true };
    },
  );

  /** Modo de teste local (nunca em produção): a conexão responde sem rede, marcada como teste. */
  app.post(
    '/api/v1/connections/:key/test-mode',
    { config: { access: CONN_MANAGE } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const p = providerDef(key);
      if (!p?.testMode || !testModeAllowed())
        throw Errors.business('Modo de teste indisponível para esta conexão ou neste ambiente.');
      const t = TEST_ACCOUNTS[key]!;
      await prisma.$transaction((tx) =>
        upsert(tx, actorFrom(request), key, {
          status: 'CONECTADA',
          mode: 'TESTE_LOCAL',
          accountId: t.accountId,
          accountLabel: t.label,
          config: t.config,
          secret: null,
          lastSyncAt: new Date(),
          lastError: null,
        }),
      );
      return { ok: true };
    },
  );
}
