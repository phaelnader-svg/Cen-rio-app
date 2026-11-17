import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { createTokenHasher } from '../src/lib/crypto';
import { panelUserWith } from './commercial-helpers';
import { Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';

/**
 * Ambiente interativo, etapa 3: o dono cria agentes para funções novas e acompanha o histórico de
 * acertos de cada tipo de proposta, para decidir quando liberar o agente para agir sozinho. O
 * Firma Viva conduz o escritório pelo escopo "escritorio". Dados fictícios.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
});

const novoAgente = {
  name: 'Pós-venda',
  roleKey: 'PERSONALIZADA',
  roleLabel: 'Pós-venda',
  instructions: 'Acompanhe os clientes depois da entrega e prepare as mensagens de satisfação.',
  dataScopes: ['clientes', 'os'],
  actionPolicies: { enviar_mensagem: 'PROPOR' },
  channelPolicies: { WHATSAPP: 'RASCUNHO' },
};

const agents = async (c: Client) => (await c.get('/api/v1/game/agents')).body as AgentDto[];

describe('jogo — agentes do escritório', () => {
  it('o dono cria um agente para uma função nova; quem só vê o jogo não cria', async () => {
    const admin = await loginAdmin(app);
    // Ao abrir o escritório pela primeira vez entram os padrões: Gerente e Financeiro.
    expect((await agents(admin)).map((a) => a.roleKey)).toEqual(['GERENTE', 'FINANCEIRO']);
    const r = await admin.req('POST', '/api/v1/game/agents', novoAgente, {
      'idempotency-key': idemKey(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const list = await agents(admin);
    const mine = list.find((a) => a.id === r.body.id)!;
    expect(mine.roleKey).toBe('PERSONALIZADA');
    expect(mine.status).toBe('ATIVO');
    expect(mine.track).toEqual({});
    // Compras não é mais oferecido como modelo.
    expect(list.map((a) => a.roleKey)).toEqual(
      expect.arrayContaining(['GERENTE', 'FINANCEIRO', 'PERSONALIZADA']),
    );
    const templates = (await admin.get('/api/v1/game/agent-templates')).body as {
      roleKey: string;
    }[];
    expect(templates.map((t) => t.roleKey)).not.toContain('COMPRAS');

    const viewer = await panelUserWith(app, admin, 'jogo-ver', ['jogo.acessar']);
    const denied = await viewer.req('POST', '/api/v1/game/agents', novoAgente, {
      'idempotency-key': idemKey(),
    });
    expect(denied.status).toBe(403);
  });

  it('o histórico de acertos conta aprovadas, recusadas e desatualizadas por tipo', async () => {
    const admin = await loginAdmin(app);
    const created = await admin.req('POST', '/api/v1/game/agents', novoAgente, {
      'idempotency-key': idemKey(),
    });
    const agentId = created.body.id as string;
    const decidedAt = new Date();
    const base = { agentId, kind: 'ENVIAR_MENSAGEM', title: 'Mensagem', detail: 'Teste' };
    await db().aiAgentProposal.createMany({
      data: [
        { ...base, title: 'A', status: 'APROVADA', decidedAt },
        { ...base, title: 'B', status: 'EXECUTADA_TESTE', decidedAt },
        { ...base, title: 'C', status: 'EXECUTADA_TESTE', decidedAt },
        { ...base, title: 'D', status: 'REJEITADA', decidedAt },
        { ...base, title: 'E', status: 'OBSOLETA', decidedAt },
        { ...base, kind: 'ATRIBUIR_TAREFA', title: 'F', status: 'APROVADA', decidedAt },
      ],
    });
    const pending = await db().aiAgentProposal.create({ data: { ...base, title: 'G' } });

    let mine = (await agents(admin)).find((a) => a.id === agentId)!;
    expect(mine.track.ENVIAR_MENSAGEM).toEqual({
      aprovadas: 3,
      recusadas: 1,
      desatualizadas: 1,
      taxaAcerto: 0.75,
    });
    expect(mine.track.ATRIBUIR_TAREFA?.taxaAcerto).toBe(1);

    const decide = await admin.req(
      'POST',
      `/api/v1/game/proposals/${pending.id}/decide`,
      { decision: 'REJEITAR', note: 'Tom inadequado' },
      { 'idempotency-key': idemKey() },
    );
    expect(decide.status, JSON.stringify(decide.body)).toBe(200);
    const conv = await admin.get(`/api/v1/game/agents/${agentId}/conversation`);
    expect(conv.status).toBe(200);
    mine = conv.body.agent as AgentDto;
    expect(mine.track.ENVIAR_MENSAGEM).toMatchObject({ recusadas: 2, taxaAcerto: 0.6 });
  });
});

describe('jogo — escritório pelo Firma Viva (escopo "escritorio")', () => {
  const SECRET = 'segredo-de-teste-do-firma-viva-0123456789abcdef';
  const REDIRECT = 'http://localhost:3100/api/conexoes/cenario/retorno';

  async function tokenFor(admin: Client, scope: string) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const r = await admin.post('/api/oauth/authorize', {
      client_id: 'firma-viva',
      redirect_uri: REDIRECT,
      scope,
      state: 'estado-123456',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      org_ref: `org-${scope.replace(/\W/g, '')}`,
      org_label: 'Cenário Estofados',
      decision: 'allow',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const code = new URL(r.body.redirect as string).searchParams.get('code')!;
    const server = new Client(app, null);
    const t = await server.post('/api/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: 'firma-viva',
      client_secret: SECRET,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    return { server, token: t.body.access_token as string, scope: t.body.scope as string };
  }

  it('com "escritorio" o dono vê o caixa e cria agentes; só com "jogo" não', async () => {
    const hash = createTokenHasher(process.env.TOKEN_HASH_SECRET!);
    await db().oAuthClient.create({
      data: {
        clientId: 'firma-viva',
        name: 'Firma Viva',
        secretHash: hash(SECRET),
        redirectUris: [REDIRECT],
        allowedScopes: ['consulta', 'jogo', 'operacao', 'escritorio'],
      },
    });
    const admin = await loginAdmin(app);
    const office = await tokenFor(admin, 'jogo operacao escritorio');
    expect(office.scope.split(' ').sort()).toEqual(['escritorio', 'jogo', 'operacao']);
    const auth = { authorization: `Bearer ${office.token}` };
    const create = await office.server.req('POST', '/api/v1/game/agents', novoAgente, {
      ...auth,
      'idempotency-key': idemKey(),
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);

    const onlyGame = await tokenFor(admin, 'jogo');
    const denied = await onlyGame.server.req('POST', '/api/v1/game/agents', novoAgente, {
      authorization: `Bearer ${onlyGame.token}`,
      'idempotency-key': idemKey(),
    });
    expect(denied.status).toBe(403);
  });
});
