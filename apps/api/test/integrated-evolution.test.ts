import { closingWeekStart, mondayOf, zonedDateTime } from '@cenario/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, receiptBody } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';
import { act, addOs, createPlan, publish, tabletOf, today, userIdOf } from './production-helpers';

/**
 * Evolução, Fase 8 — cenários integrados obrigatórios (1–10) e financeiro ponta a ponta, num
 * ÚNICO fluxo contínuo (estado compartilhado entre os passos), com relógio controlado no fuso
 * da oficina. Usa as mesmas rotas do painel e dos tablets. Único atalho de dados: a etapa da
 * peça “aprovada na qualidade” (o fluxo de inspeção completo é coberto por quality.test.ts).
 */
const TZ = 'America/Sao_Paulo';
let app: App;
let admin: Client;
const tabs: Record<string, Client> = {};
const ids: Record<string, string> = {};
const sockets: WsClient[] = [];
const MONDAY = mondayOf(today());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const clockAt = (wd: number, hhmm: string) =>
  setClock(() => zonedDateTime(addDays(MONDAY, wd), hhmm, TZ));
const post = (c: Client, url: string, body: unknown = {}, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.req('PUT', url, body, { 'idempotency-key': key });

type T = {
  id: string;
  activity: string;
  status: string;
  version: number;
  blockers: string[];
  scheduledAt: string | null;
  assignee: { userId: string } | null;
  serviceOrderItem: { id: string } | null;
};
type Q = {
  current: { id: string } | null;
  next: { id: string } | null;
  counts: { done: number; running: number; executable: number; blocked: number };
  items: { position: number; executable: boolean; task: T }[];
};
const queueOf = async (c: Client) => (await c.get('/api/v1/production-tasks/mine/queue')).body as Q;
const planOf = async (id: string) =>
  (await admin.get(`/api/v1/production-plans/${id}`)).body as {
    id: string;
    version: number;
    mode: string;
    items: { id: string; serviceOrder: { id: string } }[];
    tasks: T[];
  };
const taskRow = (id: string) => db().productionTask.findUniqueOrThrow({ where: { id } });

// Estado compartilhado do fluxo.
let so: { id: string; items: { id: string; position: number }[] };
let A: string; // peça A (Ricardo)
let B: string; // peça B (Márcio)
let plan: Awaited<ReturnType<typeof planOf>>;
const of = (item: string, activity: string) =>
  plan.tasks.find((t) => t.serviceOrderItem?.id === item && t.activity === activity)!;
let laborA: { id: string };
let laborB: { id: string };

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  clockAt(0, '07:30');
  admin = await loginAdmin(app);
  for (const n of ['Ricardo', 'Márcio', 'João', 'Thiago', 'André', 'Izaías'])
    ids[n] = await userIdOf(n);
  const pins: Record<string, string> = {
    Ricardo: '482915',
    Márcio: '602413',
    João: '271828',
    Thiago: '314159',
  };
  for (const [n, pin] of Object.entries(pins)) tabs[n] = await tabletOf(app, admin, n, pin);
}, 120_000);
afterAll(async () => {
  setClock();
  await Promise.all(sockets.map((s) => s.close()));
  await app.close();
});

async function arriveAll() {
  for (const n of ['Ricardo', 'Márcio', 'João', 'Thiago'])
    expect((await post(tabs[n]!, '/api/v1/attendance/me/arrive')).status).toBe(200);
}

describe.sequential('Cenários integrados da Evolução (Fase 8)', () => {
  it('1 + 9. OS com duas peças, titular por peça, geração idempotente (reprocessar, concorrência, modelo editado)', async () => {
    const customer = await createCustomer(admin, {
      name: 'Cliente Integrado',
      phone: null,
      allowSimilar: true,
    });
    const order = await createOrder(admin, customer, [
      { pieceType: 'SOFA', description: 'Sofá A', quantity: 1 },
      { pieceType: 'SOFA', description: 'Sofá B', quantity: 1 },
    ]);
    expect(
      (
        await post(
          admin,
          '/api/v1/receipts',
          receiptBody(
            order.id,
            order.items.map((i: { id: string }) => ({ orderItemId: i.id, quantity: 1 })),
          ),
        )
      ).status,
    ).toBe(201);
    const r = await post(admin, '/api/v1/service-orders', {
      orderId: order.id,
      items: order.items.map((i: { id: string }, k: number) => ({
        orderItemId: i.id,
        quantity: 1,
        description: k ? 'Sofá B' : 'Sofá A',
        serviceType: 'REFORMA_COMPLETA',
      })),
    });
    expect(r.status).toBe(201);
    so = r.body;
    [A, B] = so.items.sort((x, y) => x.position - y.position).map((i) => i.id) as [string, string];
    const p = await createPlan(admin, today(), 'FILA_SEMANAL');
    // Thiago faz duas tarefas avulsas (sem dependência) — usadas na reordenação (cenário 7).
    const added = await addOs(admin, p.id, {
      serviceOrderId: so.id,
      pieces: [
        { serviceOrderItemId: A, upholstererUserId: ids['Ricardo'] },
        { serviceOrderItemId: B, upholstererUserId: ids['Márcio'] },
      ],
    });
    expect(added.status).toBe(201);
    for (const title of ['Organizar retalhos', 'Conferir grampeadores'])
      expect(
        (
          await post(admin, `/api/v1/production-plans/${p.id}/tasks`, {
            serviceOrderId: so.id,
            activity: 'OUTRA',
            title,
            assigneeUserId: ids['Thiago'],
          })
        ).status,
      ).toBe(201);
    plan = await planOf(p.id);
    const generated = plan.tasks.filter((t) => t.serviceOrderItem);
    expect(generated).toHaveLength(12); // 6 etapas × 2 peças
    const snapshot = () =>
      db().productionTask.findMany({
        where: { planId: plan.id },
        orderBy: { id: 'asc' },
        select: { id: true, assigneeUserId: true, version: true },
      });
    const before = await snapshot();
    const url = `/api/v1/production-plans/${plan.id}/items/${plan.items[0]!.id}/distribute`;
    expect((await post(admin, url)).status).toBe(200);
    const both = await Promise.all([post(admin, url), post(admin, url)]);
    expect(both.map((x) => x.status)).toEqual([200, 200]);
    // Modelo editado depois da geração: reprocessar não duplica nem reatribui.
    const tpl = (await admin.get('/api/v1/production-templates')).body.find(
      (x: { pieceTypes: string[] }) => x.pieceTypes.includes('SOFA'),
    );
    expect(
      (
        await admin.put(`/api/v1/production-templates/${tpl.id}`, {
          ...tpl,
          name: `${tpl.name} v2`,
        })
      ).status,
    ).toBe(200);
    expect((await post(admin, url)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect(await db().productionTask.count({ where: { serviceOrderId: so.id } })).toBe(14);
    // Labor por peça (Fase 5): Ricardo R$ 700 na peça A; Márcio R$ 800 na peça B.
    const lab = async (who: string, item: string, cents: number) => {
      const x = await post(admin, '/api/v1/finance/labor', {
        professionalUserId: ids[who],
        serviceOrderId: so.id,
        serviceOrderItemId: item,
        service: 'Mão de obra',
        agreedCents: cents,
        eligibility: 'QUALIDADE_APROVADA',
      });
      expect(x.status).toBe(201);
      return x.body as { id: string };
    };
    laborA = await lab('Ricardo', A, 70000);
    laborB = await lab('Márcio', B, 80000);
  });

  it('2. João: desmontagem e preparação; titular: toda a tapeçaria da peça; Thiago inspeciona (sem autoinspeção)', async () => {
    const TAP = ['CORTE_TECIDO', 'COSTURA', 'MONTAGEM', 'ACABAMENTO'];
    for (const a of TAP) {
      expect(of(A, a).assignee!.userId).toBe(ids['Ricardo']);
      expect(of(B, a).assignee!.userId).toBe(ids['Márcio']);
    }
    for (const a of ['DESMONTAGEM', 'PREPARACAO']) {
      expect(of(A, a).assignee!.userId).toBe(ids['João']);
      expect(of(B, a).assignee!.userId).toBe(ids['João']);
    }
    const d = (await admin.get(`/api/v1/production-plans/${plan.id}/distribution`)).body as {
      pieces: { upholsterer: { userId: string } | null; inspector: { userId: string } | null }[];
      pendencyCount: number;
    };
    // As únicas pendências são do modelo editado no passo 1 (sem regenerar nada sozinho).
    const kinds = (d as unknown as { pieces: { pendencies: { kind: string }[] }[] }).pieces.flatMap(
      (x) => x.pendencies.map((k) => k.kind),
    );
    expect(kinds).toEqual(['MODELO_ALTERADO', 'MODELO_ALTERADO']);
    expect(d.pendencyCount).toBe(2);
    for (const piece of d.pieces) {
      expect(piece.inspector!.userId).toBe(ids['Thiago']);
      expect(piece.inspector!.userId).not.toBe(piece.upholsterer!.userId);
    }
  });

  it('3. plano novo em fila sem horário; plano antigo (LEGADO) segue exigindo o horário', async () => {
    expect(plan.mode).toBe('FILA_SEMANAL');
    expect(plan.tasks.every((t) => t.scheduledAt === null)).toBe(true);
    const legacy = await createPlan(admin, addDays(MONDAY, 14), 'LEGADO');
    const soL = await openServiceOrder(admin, 'Cliente Legado');
    expect(
      (
        await addOs(admin, legacy.id, {
          serviceOrderId: soL.id,
          principalUserId: ids['Ricardo'],
          date: addDays(MONDAY, 14),
          generate: false,
        })
      ).status,
    ).toBe(201);
    const lt = await post(admin, `/api/v1/production-plans/${legacy.id}/tasks`, {
      serviceOrderId: soL.id,
      activity: 'OUTRA',
      title: 'Tarefa por horário',
      assigneeUserId: ids['João'],
      date: addDays(MONDAY, 14),
      time: '10:00',
    });
    expect(lt.status, JSON.stringify(lt.body)).toBe(201);
    await publish(admin, (await admin.get(`/api/v1/production-plans/${legacy.id}`)).body);
    expect((await taskRow(lt.body.id)).scheduledAt).not.toBeNull();
    // Horário futuro: o tablet não consegue iniciar.
    const st = await act(tabs['João']!, lt.body.id, 'start');
    expect([409, 422]).toContain(st.status);
  });

  it('4. publicar, presença, iniciar/pausar/retomar/concluir; segunda → terça mantém posição; nada inicia sozinho', async () => {
    plan = await publish(admin, plan);
    clockAt(0, '07:55');
    await arriveAll();
    clockAt(0, '08:00');
    const q0 = await queueOf(tabs['João']!);
    const order0 = q0.items.map((e) => e.task.id);
    expect(q0.next!.id).toBe(of(A, 'DESMONTAGEM').id);
    const j = tabs['João']!;
    const d = of(A, 'DESMONTAGEM').id;
    expect((await act(j, d, 'start')).status).toBe(200);
    expect((await act(j, d, 'pause', { reason: 'OUTRO', note: 'Café' })).status).toBe(200);
    expect((await act(j, d, 'resume')).status).toBe(200);
    expect((await act(j, d, 'complete', { note: 'Pronto' })).status).toBe(200);
    const prep = await taskRow(of(A, 'PREPARACAO').id);
    expect(prep.status).toBe('LIBERADA');
    expect(prep.startedAt).toBeNull();
    // Terça: mesma ordem, mesmo estado, nada em execução.
    clockAt(1, '08:00');
    await arriveAll();
    const q1 = await queueOf(j);
    expect(q1.items.map((e) => e.task.id)).toEqual(order0.filter((id) => id !== d));
    expect(q1.counts.done).toBe(1);
    expect(q1.current).toBeNull();
    expect(await db().productionTask.count({ where: { status: 'EM_EXECUCAO' } })).toBe(0);
  });

  it('5 + 6. ocorrência bloqueia; próxima executável sem reordenar; desbloqueio não interrompe; uma principal ativa; ajuda mantém o principal', async () => {
    const j = tabs['João']!;
    const prepA = of(A, 'PREPARACAO').id;
    const desmB = of(B, 'DESMONTAGEM').id;
    const before = (await queueOf(j)).items.map((e) => e.task.id);
    expect((await act(j, prepA, 'start')).status).toBe(200);
    const issue = await post(j, '/api/v1/issues', {
      taskId: prepA,
      kind: 'TECNICO',
      description: 'Grampeador pneumático sem pressão',
      impact: 'IMPEDIDO',
    });
    expect(issue.status).toBe(201);
    const q = await queueOf(j);
    expect(q.items.map((e) => e.task.id)).toEqual(before); // ordem original preservada
    expect(q.next!.id).toBe(desmB);
    expect((await act(j, desmB, 'start')).status).toBe(200);
    // Resolver a ocorrência não interrompe a tarefa atual (nem retoma a pausada sozinha).
    const rq = await post(admin, `/api/v1/issues/${issue.body.id}/request-verification`, {
      note: 'Compressor trocado',
    });
    const vf = await post(admin, `/api/v1/issues/${issue.body.id}/verify`, {
      resolved: true,
      note: 'Conferido com o João',
    });
    expect(rq.status).toBe(200);
    expect(vf.status, JSON.stringify(vf.body)).toBe(200);
    expect((await taskRow(desmB)).status).toBe('EM_EXECUCAO');
    expect((await taskRow(prepA)).status).toBe('PAUSADA');
    // Uma principal ativa: retomar a outra enquanto há uma em execução é recusado.
    expect((await act(j, prepA, 'resume')).status).toBe(409);
    expect((await act(j, desmB, 'complete', { note: 'Pronto' })).status).toBe(200);
    // Concorrência: duas principais ao mesmo tempo → só uma.
    const prepB = of(B, 'PREPARACAO').id;
    const both = await Promise.all([act(j, prepA, 'resume'), act(j, prepB, 'start')]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const active = await db().productionTask.count({
      where: { assigneeUserId: ids['João'], status: 'EM_EXECUCAO', supportForTaskId: null },
    });
    expect(active).toBe(1);
  });

  it('7. reordenar com motivo e versão; tablet recebe ao vivo e reconcilia após ficar offline', async () => {
    const t = tabs['Thiago']!;
    const q = await queueOf(t);
    const mine = q.items.filter((e) => e.task.activity === 'OUTRA').map((e) => e.task.id);
    expect(mine).toHaveLength(2);
    const live = await WsClient.connect(app, t);
    sockets.push(live);
    // Offline: guarda a última sequência e desconecta.
    const offline = await WsClient.connect(app, t);
    const lastSeq = offline.messages.find((m) => m.kind === 'hello')!.headSeq as string;
    await offline.close();
    const cur = await planOf(plan.id);
    const url = `/api/v1/production-plans/${plan.id}/queue`;
    const reversed = [...mine].reverse();
    expect(
      (await put(admin, url, { userId: ids['Thiago'], taskIds: reversed, version: cur.version }))
        .status,
    ).toBe(400); // publicado exige motivo
    expect(
      (
        await put(admin, url, {
          userId: ids['Thiago'],
          taskIds: reversed,
          version: cur.version - 1,
          reason: 'Cliente pediu os grampeadores antes',
        })
      ).status,
    ).toBe(409); // versão desatualizada
    const ok = await put(admin, url, {
      userId: ids['Thiago'],
      taskIds: reversed,
      version: cur.version,
      reason: 'Cliente pediu os grampeadores antes',
    });
    expect(ok.status).toBe(200);
    await live.waitFor((m) => m.event?.type === 'production.queue_reordered');
    const back = await WsClient.connect(app, t, lastSeq);
    sockets.push(back);
    await back.waitFor((m) => m.kind === 'replay.done');
    expect(back.events('production.queue_reordered')).toHaveLength(1);
    const after = (await queueOf(t)).items
      .filter((e) => e.task.activity === 'OUTRA')
      .map((e) => e.task.id);
    expect(after).toEqual(reversed);
  });

  it('8. substituição excepcional do titular: autorização, motivo, tarefa ativa protegida, revisão sem mover dinheiro', async () => {
    const m = tabs['Márcio']!;
    const corteB = (await planOf(plan.id)).tasks.find(
      (x) => x.serviceOrderItem?.id === B && x.activity === 'CORTE_TECIDO',
    )!;
    await admin.put(`/api/v1/production-tasks/${corteB.id}`, {
      requiresMaterials: false,
      version: corteB.version,
      reason: 'Tecido do cliente já na oficina',
    });
    expect((await act(m, corteB.id, 'start')).status).toBe(200);
    // Ajuda (cenário 6): o Márcio pede apoio; ele continua o responsável principal da etapa.
    const help = await post(m, '/api/v1/help-requests', { taskId: corteB.id, kind: 'PARAFUSAR' });
    expect(help.status, JSON.stringify(help.body)).toBe(201);
    expect((await taskRow(corteB.id)).assigneeUserId).toBe(ids['Márcio']);
    const support = await db().productionTask.findMany({ where: { supportForTaskId: corteB.id } });
    expect(support.every((t) => t.assigneeUserId !== ids['Márcio'])).toBe(true);
    const url = `/api/v1/service-order-items/${B}/upholsterer`;
    const body = {
      userId: ids['Ricardo'],
      expectedUserId: ids['Márcio'],
      reason: 'Márcio afastado',
      confirm: true,
    };
    expect((await put(admin, url, body)).status).toBe(422); // etapa de tapeçaria em execução
    expect((await put(m, url, body)).status).toBe(403); // funcionário não troca titular
    expect((await act(m, corteB.id, 'complete', { note: 'Corte pronto' })).status).toBe(200);
    const paysBefore = await db().professionalPayment.count();
    const okR = await put(admin, url, body);
    expect(okR.status).toBe(200);
    expect(okR.body).toMatchObject({ changed: true, financialReviewRequired: true });
    expect(
      await db().serviceOrderItemOwnerChange.count({ where: { serviceOrderItemId: B } }),
    ).toBeGreaterThan(0);
    expect(await db().auditLog.count({ where: { entityId: B } })).toBeGreaterThan(0);
    const rv = (await admin.get('/api/v1/finance/labor-reviews?status=ABERTA')).body;
    expect(rv).toHaveLength(1);
    const lb = await db().productionPayable.findUniqueOrThrow({ where: { id: laborB.id } });
    expect(lb.professionalUserId).toBe(ids['Márcio']); // nada transferido automaticamente
    expect(await db().professionalPayment.count()).toBe(paysBefore);
    // Corte já feito pelo Márcio continua registrado como dele.
    expect((await taskRow(corteB.id)).assigneeUserId).toBe(ids['Márcio']);
  });

  it('financeiro: concluir não paga; liberação por qualidade; revisão trava; divisão reconhecida; Pix externo, estorno e fechamento', async () => {
    expect(await db().professionalPayment.count()).toBe(0);
    expect(
      (await db().productionPayable.findUniqueOrThrow({ where: { id: laborA.id } })).status,
    ).toBe('PREVISTO');
    // Qualidade aprovada nas duas peças (atalho de dados — ver cabeçalho).
    await db().serviceOrderItem.updateMany({
      where: { id: { in: [A, B] } },
      data: { fulfillmentStage: 'AGUARDANDO_EMBALAGEM' },
    });
    await admin.get('/api/v1/finance/labor');
    const week = closingWeekStart(today());
    const C = `/api/v1/finance/weekly-closings/${week}`;
    let d = (await admin.get(C)).body;
    const row = (name: string) =>
      d.rows.find(
        (r: { beneficiary: { displayName: string }; category: string }) =>
          r.beneficiary.displayName === name && r.category === 'TAPECARIA',
      );
    expect(row('Ricardo')).toMatchObject({ weekDueCents: 70000 });
    expect(row('Márcio')?.weekDueCents ?? 0).toBe(0); // em revisão: fora do pagável
    expect(d.pendencies.some((p: { kind: string }) => p.kind === 'REVISAO_ABERTA')).toBe(true);
    // Divisão reconhecida: R$ 300 (Márcio, corte) + R$ 500 (Ricardo) sobre os R$ 800.
    const rv = (await admin.get('/api/v1/finance/labor-reviews?status=ABERTA')).body[0];
    expect(
      (
        await post(admin, `/api/v1/finance/labor-reviews/${rv.id}/resolve`, {
          lines: [
            { professionalUserId: ids['Márcio'], amountCents: 30000 },
            { professionalUserId: ids['Ricardo'], amountCents: 50000 },
          ],
          reason: 'Corte feito pelo Márcio; restante pelo Ricardo',
          version: rv.version,
        })
      ).status,
    ).toBe(200);
    await admin.get('/api/v1/finance/labor');
    d = (await admin.get(C)).body;
    expect(row('Ricardo')).toMatchObject({ weekDueCents: 120000 });
    expect(row('Márcio')).toMatchObject({ weekDueCents: 30000 });
    // Pix externo parcial ao Ricardo; repetição idempotente; acima do saldo recusado.
    const accounts = await db().accountPayable.count();
    const expenses = await db().operationalExpense.count();
    const key = idemKey();
    const pixBody = {
      beneficiaryUserId: ids['Ricardo'],
      category: 'TAPECARIA',
      amountCents: 60000,
      paidAt: addDays(MONDAY, 1), // data do relógio controlado (terça)
      method: 'PIX',
      reference: 'INTEGRADO-1',
    };
    const p1 = await post(admin, `${C}/payments`, pixBody, key);
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    const p2 = await post(admin, `${C}/payments`, pixBody, key);
    expect(p2.status).toBe(201);
    expect(await db().closingPayment.count()).toBe(1);
    expect((await post(admin, `${C}/payments`, { ...pixBody, amountCents: 60001 })).status).toBe(
      422,
    );
    d = (await admin.get(C)).body;
    expect(row('Ricardo')).toMatchObject({ paidInWeekCents: 60000, openAtEndCents: 60000 });
    expect(await db().accountPayable.count()).toBe(accounts);
    expect(await db().operationalExpense.count()).toBe(expenses);
    // Conferir; estorno imutável do Pix; reabrir com motivo.
    expect(
      (await post(admin, `${C}/confirm`, { version: d.version, note: 'Conferido' })).status,
    ).toBe(200);
    const pf = p1.body.payments[0];
    expect(
      (
        await post(admin, `/api/v1/finance/closing-payments/${pf.id}/reverse`, {
          reason: 'Pix devolvido',
        })
      ).status,
    ).toBe(200);
    d = (await admin.get(C)).body;
    expect(row('Ricardo')).toMatchObject({ paidInWeekCents: 0, openAtEndCents: 120000 });
    // Estorno não muda o DEVIDO conferido (sem divergência); fica no histórico do fechamento.
    expect(d.divergent).toBe(false);
    expect(JSON.stringify(d.history)).toMatch(/ESTORN/i);
    expect(
      (await post(admin, `${C}/reopen`, { version: d.version, reason: 'Estorno do Pix' })).status,
    ).toBe(200);
    expect(await db().closingPaymentReversal.count()).toBe(1);
  });

  it('10. semana encerrada com pendências: replanejamento explícito, sem perder histórico nem duplicar', async () => {
    const next = await createPlan(admin, addDays(MONDAY, 7), 'FILA_SEMANAL');
    const soN = await openServiceOrder(admin, 'Cliente Semana Seguinte');
    await addOs(admin, next.id, {
      serviceOrderId: soN.id,
      principalUserId: ids['Ricardo'],
      generate: false,
    });
    await post(admin, `/api/v1/production-plans/${next.id}/tasks`, {
      serviceOrderId: soN.id,
      activity: 'OUTRA',
      title: 'Revisar ferramentas',
      assigneeUserId: ids['Thiago'],
    });
    await publish(admin, (await admin.get(`/api/v1/production-plans/${next.id}`)).body);
    const open = await db().productionTask.findMany({
      where: {
        planId: plan.id,
        status: { in: ['LIBERADA', 'BLOQUEADA', 'PAUSADA'] },
        assigneeUserId: ids['Thiago'],
      },
    });
    expect(open.length).toBeGreaterThan(0);
    const body = { toPlanId: next.id, taskIds: open.map((t) => t.id), reason: 'Sobrou da semana' };
    clockAt(4, '17:00');
    expect((await post(admin, `/api/v1/production-plans/${plan.id}/carry-over`, body)).status).toBe(
      422,
    );
    clockAt(5, '09:00');
    const p = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    expect(p.weekEnded).toBe(true);
    const total = await db().productionTask.count();
    const events = await db().productionTaskEvent.count();
    const key = idemKey();
    const r1 = await post(admin, `/api/v1/production-plans/${plan.id}/carry-over`, body, key);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.moved).toBe(open.length);
    const r2 = await post(admin, `/api/v1/production-plans/${plan.id}/carry-over`, body);
    expect(r2.body.moved).toBe(0);
    expect(await db().productionTask.count()).toBe(total); // nada duplicado
    expect(await db().productionTaskEvent.count()).toBeGreaterThan(events); // histórico acrescido
    const moved = await db().productionTask.findMany({ where: { id: { in: body.taskIds } } });
    expect(moved.every((t) => t.planId === next.id && t.carriedFromPlanId === plan.id)).toBe(true);
  });
});
