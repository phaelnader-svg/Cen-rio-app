import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { OfficeOverviewDto, OwnerChatReplyDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { setChatModel, type ChatModel } from '../src/modules/game/owner-chat';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer } from './commercial-helpers';

/**
 * Conversar (app do dono, 2026-11-25): a IA responde chamando as ferramentas; os números vêm do
 * sistema em cartões e os pedidos de tarefa viram cartões no Aprovar. Aqui a IA é trocada por um
 * roteiro, para conferir o caminho inteiro sem depender da rede.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock(() => new Date('2026-11-25T15:00:00Z'));
  await db().companySettings.update({
    where: { id: 1 },
    data: { plan: 'gestao_jogo', tradeName: 'Tapeçaria Teste' },
  });
});
afterEach(() => setChatModel(null));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const ask = (c: Client, text: string) =>
  send(c, 'POST', '/api/v1/office/chat', { messages: [{ role: 'user', text }] });

let n = 0;
const msg = (content: unknown[], stop: string): Anthropic.Beta.BetaMessage =>
  ({ id: `m${n++}`, role: 'assistant', content, stop_reason: stop }) as never;
const use = (name: string, input: Record<string, string>) =>
  msg([{ type: 'tool_use', id: `t${n}`, name, input }], 'tool_use');
const say = (text: string) => msg([{ type: 'text', text }], 'end_turn');
/** Último resultado de ferramenta que a IA recebeu. */
const lastResult = (messages: Anthropic.Beta.BetaMessageParam[]) => {
  const c = messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
  return String(c[0]!.content);
};

describe('Conversar com a IA', () => {
  it('lucro do mês: a IA chama a ferramenta e o número vem do sistema', async () => {
    const admin = await loginAdmin(app);
    const ana = (await createCustomer(admin, { name: 'Ana Souza' })) as { id: string };
    await db().commercialOrder.create({
      data: {
        customerId: ana.id,
        contractedService: 'Reforma',
        agreedValueCents: 250_000,
        status: 'RECEBIDO',
        createdAt: new Date('2026-10-12T12:00:00Z'),
      },
    });
    const seen: string[] = [];
    const script: ChatModel = async ({ messages, system }) => {
      expect(system).toMatch(/Hoje é 25\/11\/2026/);
      if (messages.length === 1) return use('dinheiro', { de: '2026-10-01', ate: '2026-10-31' });
      seen.push(lastResult(messages));
      return say('Em outubro fechou R$ 2.500,00.');
    };
    setChatModel(script);
    const r = ok<OwnerChatReplyDto>(await ask(admin, 'quanto fechei em outubro?'));
    expect(r.reply).toMatch(/outubro/);
    expect(seen[0]).toMatch(/2\.500,00/);
    const card = r.cards[0]!;
    expect(card.kind).toBe('numeros');
    if (card.kind !== 'numeros') return;
    expect(card.title).toBe('Dinheiro de 01/10/2026 a 31/10/2026');
    const fechou = card.rows.find((x) => x.label.startsWith('Fechou'))!;
    expect(fechou.label).toBe('Fechou (1 serviço)');
    expect(fechou.value.replace(/\s/g, ' ')).toBe('R$ 2.500,00');
  });

  it('pedido de mensagem vira cartão no Aprovar e só sai com o link depois de aprovar', async () => {
    const admin = await loginAdmin(app);
    ok(await send(admin, 'POST', '/api/v1/office/hire', { roleKey: 'ATENDIMENTO' }), 201);
    await createCustomer(admin, { name: 'Ana Souza', phone: '(12) 99111-0001' });
    setChatModel(async ({ messages }) => {
      if (messages.length === 1) return use('cliente', { nome: 'ana' });
      if (messages.length === 3) {
        const [c] = JSON.parse(lastResult(messages)) as { id: string; tem_whatsapp: boolean }[];
        expect(c!.tem_whatsapp).toBe(true);
        return use('pedir_mensagem', {
          cliente_id: c!.id,
          mensagem: 'Olá, Ana! Seu sofá fica pronto na sexta.',
        });
      }
      expect(lastResult(messages)).toMatch(/Aprovar/);
      return say('Deixei a mensagem no Aprovar.');
    });
    const r = ok<OwnerChatReplyDto>(await ask(admin, 'avisa a Ana que o sofá fica pronto sexta'));
    const card = r.cards.find((c) => c.kind === 'aprovar')!;
    expect(card).toMatchObject({ title: 'Mensagem para Ana Souza' });
    // Nada saiu: está esperando o dono.
    const p = (await admin.get('/api/v1/office')).body as OfficeOverviewDto;
    const pending = p.pending.find((x) => x.task === 'MENSAGEM_PEDIDA')!;
    expect(pending.id).toBe(card.kind === 'aprovar' ? card.proposalId : '');
    const d = ok(
      await send(admin, 'POST', `/api/v1/game/proposals/${pending.id}/decide`, {
        decision: 'APROVAR',
      }),
    );
    expect(d.payload.sent).toBe(false);
    expect(decodeURIComponent(String(d.payload.href))).toMatch(
      /wa\.me\/5512991110001\?text=Olá, Ana! Seu sofá fica pronto na sexta\./,
    );
  });

  it('sem a IA ligada no servidor, avisa em vez de inventar', async () => {
    const admin = await loginAdmin(app);
    const r = await ask(admin, 'quanto lucrei?');
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/IA ligada/);
  });
});
