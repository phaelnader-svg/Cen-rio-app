/**
 * Central de Conexões → Cenário Gestão. Conectar abre a tela OFICIAL do Cenário (login e
 * autorização lá); o retorno troca o código por tokens no servidor (PKCE + segredo do cliente)
 * e guarda tudo selado. Desconectar revoga no Cenário e apaga os tokens; a planta continua.
 */
import type { CenarioConnection } from '@firma/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { cenarioJson, isActive, tokenRequest } from '../lib/cenario';
import { pkceChallenge, randomToken } from '../lib/crypto';
import { E } from '../lib/errors';
import { syncOnConnect } from '../lib/sync';

export const CENARIO_SCOPES = ['jogo', 'operacao', 'escritorio'];

export function connectionView(c: CenarioConnection | null) {
  return {
    status: c?.status ?? 'NAO_CONECTADA',
    company: c ? { name: c.companyName, document: c.companyDocument } : null,
    cenarioUser: c?.cenarioUserName ? { name: c.cenarioUserName, email: c.cenarioUserEmail } : null,
    scopes: c?.scopes ?? [],
    permissions: c?.permissions ?? [],
    connectedAt: c?.connectedAt?.toISOString() ?? null,
    lastSyncAt: c?.lastSyncAt?.toISOString() ?? null,
    lastError: c?.lastError ?? null,
  };
}

export async function connectionRoutes(app: FastifyInstance) {
  const { db, env, hash, seal, unseal } = app.firma;

  app.get('/api/conexoes/cenario', { config: { rule: { org: 'MEMBRO' } } }, async (request) =>
    connectionView(await db.cenarioConnection.findUnique({ where: { orgId: request.org!.id } })),
  );

  /** Gera o endereço da tela oficial do Cenário (state + PKCE guardados no servidor). */
  app.post(
    '/api/conexoes/cenario/iniciar',
    { config: { rule: { org: 'ADMIN' } } },
    async (request) => {
      const state = randomToken();
      const verifier = randomToken(48);
      await db.oAuthState.create({
        data: {
          stateHash: hash(state),
          orgId: request.org!.id,
          userId: request.user!.id,
          verifierEnc: seal(verifier),
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
      const url = new URL(`${env.CENARIO_WEB_URL}/autorizar`);
      url.searchParams.set('client_id', env.FIRMA_CENARIO_CLIENT_ID);
      url.searchParams.set('redirect_uri', env.FIRMA_CENARIO_REDIRECT_URI);
      url.searchParams.set('scope', CENARIO_SCOPES.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', pkceChallenge(verifier));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('org_ref', request.org!.id);
      url.searchParams.set('org_label', request.org!.name);
      await audit(request, {
        action: 'conexao.iniciada',
        summary: 'Abriu a autorização oficial do Cenário Gestão.',
      });
      return { url: url.toString() };
    },
  );

  /** Retorno do Cenário (navegador). Sempre volta ao jogo com o resultado. */
  app.get(
    '/api/conexoes/cenario/retorno',
    { config: { rule: { user: true } } },
    async (request, reply) => {
      const q = z
        .object({
          state: z.string().min(10).max(200),
          code: z.string().max(200).optional(),
          error: z.string().max(60).optional(),
        })
        .parse(request.query);
      const back = (result: string, message?: string) =>
        reply.redirect(
          `${env.FIRMA_WEB_URL}/jogo?central=CENARIO&conexao=${result}${message ? `&mensagem=${encodeURIComponent(message)}` : ''}`,
        );
      const st = await db.oAuthState.findUnique({ where: { stateHash: hash(q.state) } });
      if (!st || st.usedAt || st.expiresAt <= new Date() || st.userId !== request.user!.id)
        return back('erro', 'Pedido de conexão inválido ou expirado. Tente conectar de novo.');
      await db.oAuthState.update({ where: { id: st.id }, data: { usedAt: new Date() } });
      // A pessoa precisa continuar sendo ADMIN/DONO desta organização.
      const m = await db.membership.findUnique({
        where: { orgId_userId: { orgId: st.orgId, userId: st.userId } },
      });
      if (!m || !['DONO', 'ADMIN'].includes(m.role))
        return back('erro', 'Sem permissão para conectar.');
      if (q.error || !q.code)
        return back('cancelada', 'Conexão cancelada na tela do Cenário Gestão.');

      const t = await tokenRequest(app, {
        grant_type: 'authorization_code',
        code: q.code,
        code_verifier: unseal(st.verifierEnc),
        redirect_uri: env.FIRMA_CENARIO_REDIRECT_URI,
      });
      if (!t.ok)
        return back(
          'erro',
          `O Cenário Gestão recusou a autorização (${String(t.data.error_description ?? t.status)}).`,
        );
      const company = t.data.company as { name: string; document: string | null };
      const user = t.data.user as { name: string; email: string | null };
      const companyKey = `${env.CENARIO_API_URL}#${company.document || company.name}`.toLowerCase();
      const org = await db.organization.findUniqueOrThrow({ where: { id: st.orgId } });

      // Uma empresa só pode estar vinculada a uma organização.
      const other = await db.cenarioConnection.findFirst({
        where: { companyKey, status: 'CONECTADA', orgId: { not: st.orgId } },
      });
      if (other) {
        await revokeAtCenario(app, String(t.data.refresh_token));
        return back(
          'erro',
          `A empresa ${company.name} já está vinculada a outra organização do Firma Viva.`,
        );
      }
      const previous = await db.cenarioConnection.findUnique({ where: { orgId: st.orgId } });
      if (previous && previous.companyKey !== companyKey && previous.status !== 'DESCONECTADA') {
        await revokeAtCenario(app, String(t.data.refresh_token));
        return back(
          'erro',
          `Esta organização está vinculada a ${previous.companyName}. Desconecte antes de vincular outra empresa.`,
        );
      }
      const data = {
        status: 'CONECTADA',
        companyKey,
        companyName: company.name,
        companyDocument: company.document,
        cenarioUserName: user.name,
        cenarioUserEmail: user.email,
        scopes: String(t.data.scope ?? '')
          .split(' ')
          .filter(Boolean),
        grantId: String(t.data.grant_id ?? ''),
        accessEnc: seal(String(t.data.access_token)),
        refreshEnc: seal(String(t.data.refresh_token)),
        accessExpiresAt: new Date(Date.now() + Number(t.data.expires_in ?? 3600) * 1000),
        connectedById: st.userId,
        connectedAt: new Date(),
        lastSyncAt: new Date(),
        lastError: null,
      };
      await db.cenarioConnection.upsert({
        where: { orgId: st.orgId },
        create: { orgId: st.orgId, ...data },
        update: data,
      });
      request.org = { id: org.id, name: org.name, role: m.role as 'DONO' | 'ADMIN' };
      try {
        const me = await cenarioJson<{ permissions: string[] }>(request, 'GET', '/api/v1/apps/me');
        await db.cenarioConnection.update({
          where: { orgId: org.id },
          data: { permissions: me.permissions },
        });
        const summary = await syncOnConnect(request);
        await audit(request, {
          action: 'conexao.conectada',
          summary: `Cenário Gestão conectado: ${company.name} (autorizado por ${user.name}). ${summary}`,
          company: company.name,
        });
      } catch (e) {
        request.log.warn(e, 'Falha na sincronização inicial');
        await db.cenarioConnection.update({
          where: { orgId: org.id },
          data: {
            lastError:
              `Conectado, mas a sincronização inicial falhou: ${(e as Error).message}`.slice(
                0,
                300,
              ),
          },
        });
      }
      return back('ok');
    },
  );

  app.post(
    '/api/conexoes/cenario/desconectar',
    { config: { rule: { org: 'ADMIN' } } },
    async (request) => {
      const c = await db.cenarioConnection.findUnique({ where: { orgId: request.org!.id } });
      if (!c) throw E.notFound('Conexão');
      if (c.refreshEnc) await revokeAtCenario(app, unseal(c.refreshEnc));
      await db.cenarioConnection.update({
        where: { id: c.id },
        data: {
          status: 'DESCONECTADA',
          accessEnc: null,
          refreshEnc: null,
          accessExpiresAt: null,
          lastError: null,
        },
      });
      await audit(request, {
        action: 'conexao.desconectada',
        summary: `Cenário Gestão desconectado (${c.companyName}). Planta e configurações preservadas.`,
        company: c.companyName,
      });
      return connectionView(await db.cenarioConnection.findUnique({ where: { id: c.id } }));
    },
  );

  /** Confere a conexão agora (renova se preciso) e atualiza permissões e última sincronização. */
  app.post(
    '/api/conexoes/cenario/testar',
    { config: { rule: { org: 'GESTOR' } } },
    async (request) => {
      const me = await cenarioJson<{ permissions: string[]; company: { name: string } }>(
        request,
        'GET',
        '/api/v1/apps/me',
      );
      const c = await db.cenarioConnection.update({
        where: { orgId: request.org!.id },
        data: { permissions: me.permissions, lastSyncAt: new Date() },
      });
      return connectionView(c);
    },
  );
}

async function revokeAtCenario(app: FastifyInstance, refreshToken: string) {
  const { env } = app.firma;
  try {
    await app.cenarioFetch(`${env.CENARIO_API_URL}/api/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: refreshToken,
        client_id: env.FIRMA_CENARIO_CLIENT_ID,
        client_secret: env.FIRMA_CENARIO_CLIENT_SECRET,
      }),
    });
  } catch {
    // Mesmo sem resposta, os tokens são apagados aqui; o Cenário expira o acesso sozinho.
  }
}

export function connectionOf(request: FastifyRequest) {
  return request.server.firma.db.cenarioConnection.findUnique({
    where: { orgId: request.org!.id },
  });
}
export { isActive };
