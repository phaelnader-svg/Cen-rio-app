import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { createTestApp, db, resetDatabase } from './helpers';
import { day, today } from './production-helpers';
import { grant } from './measurement-helpers';
import { post, qualityKit } from './quality-helpers';

/**
 * Fase 8 do plano principal — qualidade, finalização e entrega. Contraprovas dos defeitos
 * encontrados na auditoria (cada uma falhava antes da correção) e aceites. Dados fictícios.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
const setClock = (hhmm: string) => setAttendanceClock(() => zonedDateTime(today(), hhmm, TZ));
const k = qualityKit(() => app);

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  setClock('09:00');
});
afterEach(() => setAttendanceClock());

type S = Awaited<ReturnType<typeof k.scenario>>;

/** Nova etapa obrigatória numa peça (plano publicado de novo, como o gestor faz). */
async function addRequiredTask(s: S, itemId: string, assigneeUserId: string) {
  const t = await s.task({
    activity: 'ACABAMENTO',
    title: 'Retoque de acabamento',
    serviceOrderItemId: itemId,
    role: 'PRINCIPAL',
    assigneeUserId,
    reason: 'Retoque pedido na conferência',
  });
  return t;
}
async function technicalChange(s: S, itemId: string, color: string) {
  const item = await db().serviceOrderItem.findUniqueOrThrow({ where: { id: itemId } });
  const r = await s.admin.put(`/api/v1/service-orders/${s.so.id}/items/${itemId}`, {
    serviceType: item.serviceType,
    description: item.description,
    fabricName: 'Linho',
    fabricColor: color,
    reason: 'Cliente trocou a cor do tecido',
    version: item.version,
  });
  return r;
}

async function orderState(s: S) {
  const so = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
  return (await s.admin.get(`/api/v1/orders/${so.orderId}`)).body.serviceState as string;
}

describe('Contraprovas — qualidade', () => {
  it('QA. aprovação invalidada com etapa nova em aberto: ao concluir a etapa nasce nova inspeção', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const extra = await addRequiredTask(s, s.sofa.id, s.ids.ricardo);
    expect((await technicalChange(s, s.sofa.id, 'Areia')).status).toBe(200);
    expect(await k.openOf(s.sofa.id)).toBeNull(); // produção incompleta: ainda não reinspeciona
    await k.finish(s.tablets.Ricardo!, extra.id);
    const open = await k.openOf(s.sofa.id);
    expect(open).not.toBeNull();
    expect(open!.reason).toBe('ALTERACAO_TECNICA');
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_INSPECAO');
    // Nova aprovação libera de novo (o histórico anterior continua).
    await k.approveOpen(s, s.sofa.id);
    const rounds = await db().qualityInspection.findMany({
      where: { serviceOrderItemId: s.sofa.id },
      orderBy: { round: 'asc' },
    });
    expect(rounds.map((r) => r.status)).toEqual(['INVALIDADA', 'APROVADA']);
  });

  it('QB. etapa obrigatória nova numa peça pronta: a etapa gravada volta para produção', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    await addRequiredTask(s, s.sofa.id, s.ids.ricardo);
    expect(await k.stage(s.sofa.id)).toBe('EM_PRODUCAO');
  });

  it('QC. as duas últimas etapas concluídas ao mesmo tempo: exatamente uma inspeção', async () => {
    for (let round = 0; round < 3; round++) {
      await resetDatabase();
      await db().companySettings.update({
        where: { id: 1 },
        data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
      });
      const s = await k.scenario();
      const second = await addRequiredTask(s, s.sofa.id, s.ids.marcio);
      for (const [c, id] of [
        [s.tablets.Ricardo!, s.sofaTask.id],
        [s.tablets.Márcio!, second.id],
      ] as const)
        expect((await post(c, `/api/v1/production-tasks/${id}/start`)).status).toBe(200);
      const [a, b] = await Promise.all([
        post(s.tablets.Ricardo!, `/api/v1/production-tasks/${s.sofaTask.id}/complete`, {
          note: 'ok',
        }),
        post(s.tablets.Márcio!, `/api/v1/production-tasks/${second.id}/complete`, { note: 'ok' }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await db().qualityInspection.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(
        1,
      );
    }
  });

  it('QD. aprovar × alteração técnica simultâneas: nunca erro interno (sem deadlock)', async () => {
    for (let round = 0; round < 3; round++) {
      await resetDatabase();
      await db().companySettings.update({
        where: { id: 1 },
        data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
      });
      const s = await k.scenario();
      await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
      const i = await k.checkAll(s.tablets.Thiago!, (await k.openOf(s.sofa.id))!.id);
      const [ap, ch] = await Promise.all([
        post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/approve`, {
          version: i.version,
        }),
        technicalChange(s, s.sofa.id, `Cor ${round}`),
      ]);
      expect(ap.status).toBeLessThan(500);
      expect(ch.status).toBeLessThan(500);
      // Seja qual for a ordem, a peça alterada nunca fica aprovada com a versão antiga.
      const last = await db().qualityInspection.findFirst({
        where: { serviceOrderItemId: s.sofa.id, status: { not: 'CANCELADA' } },
        orderBy: { round: 'desc' },
      });
      expect(last!.status).not.toBe('APROVADA');
    }
  });
});

describe('Contraprovas — entrega', () => {
  it('E2. peça marcada no destino só fica "Entregue" quando a entrega é concluída', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    const d = (await k.schedule(s, { itemIds: [s.sofa.id, s.poltronas.id] })).body;
    const andre = await k.andreTablet(s);
    let v = await k.toDestination(andre, d);
    const marked = await post(andre, `/api/v1/deliveries/${d.id}/items`, {
      items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
      version: v,
    });
    expect(marked.status).toBe(200);
    expect(await k.stage(s.sofa.id)).toBe('EM_TRANSPORTE');
    expect(await orderState(s)).not.toBe('SERVICO_CONCLUIDO');
    // Corrige no destino: a peça não foi entregue — nada fica "entregue" nem liberado por isso.
    v = (
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [
          { serviceOrderItemId: s.sofa.id, status: 'NAO_ENTREGUE', note: 'Cliente recusou' },
          { serviceOrderItemId: s.poltronas.id, status: 'ENTREGUE' },
        ],
        version: marked.body.version,
      })
    ).body.version;
    const done = await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: v });
    expect(done.status).toBe(200);
    expect(await k.stage(s.poltronas.id)).toBe('ENTREGUE');
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    expect(
      await db().productionPayable.count({
        where: { serviceOrderItemId: s.sofa.id, eligibleAt: { not: null } },
      }),
    ).toBe(0);
  });

  it('E-trânsito. aprovação invalidada com a peça no caminhão: não pode ser marcada entregue', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s)).body;
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    expect((await technicalChange(s, s.sofa.id, 'Grafite')).status).toBe(200);
    const cur = (await s.admin.get(`/api/v1/deliveries/${d.id}`)).body.version ?? v;
    const r = await post(andre, `/api/v1/deliveries/${d.id}/items`, {
      items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
      version: cur,
    });
    expect(r.status).toBe(422);
    expect(await k.stage(s.sofa.id)).not.toBe('ENTREGUE');
  });

  it('E3. equipe própria responsável executa a própria entrega (sem permissão nova)', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = await k.schedule(s, { team: 'EQUIPE_PROPRIA', responsibleUserId: s.ids.thiago });
    expect(d.status).toBe(201);
    const thiago = s.tablets.Thiago!;
    const dep = await post(thiago, `/api/v1/deliveries/${d.body.id}/depart`, {
      version: d.body.version,
    });
    expect(dep.status).toBe(200);
    // Outra pessoa da produção não executa a entrega do Thiago.
    const other = await post(s.tablets.Ricardo!, `/api/v1/deliveries/${d.body.id}/arrive`, {
      version: dep.body.version,
    });
    expect(other.status).toBe(403);
  });

  it('E4. trocar para equipe própria não mantém custo de terceirização', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s, { tripCost: { amountCents: 9000 } })).body;
    expect(await db().logisticsCost.count({ where: { deliveryId: d.id } })).toBe(1);
    const r = await s.admin.put(`/api/v1/deliveries/${d.id}`, {
      scheduledDate: day(2),
      windowStart: '10:00',
      team: 'EQUIPE_PROPRIA',
      responsibleUserId: s.ids.thiago,
      itemIds: [s.sofa.id],
      reason: 'A equipe da casa leva',
      version: d.version,
    });
    expect(r.status).toBe(422);
    const c = await db().logisticsCost.findFirstOrThrow({ where: { deliveryId: d.id } });
    expect(c.status).toBe('PREVISTO');
  });

  it('E5. reagendar sem trocar o endereço mantém o endereço da entrega', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (
      await k.schedule(s, {
        address: { street: 'Rua da Casa de Praia', number: '7', city: 'Ubatuba', state: 'SP' },
      })
    ).body;
    expect(d.address.street).toBe('Rua da Casa de Praia');
    const r = await s.admin.put(`/api/v1/deliveries/${d.id}`, {
      scheduledDate: day(2),
      windowStart: '10:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: s.ids.andre,
      itemIds: [s.sofa.id],
      reason: 'Cliente pediu outro dia',
      version: d.version,
    });
    expect(r.status).toBe(200);
    expect(r.body.address.street).toBe('Rua da Casa de Praia');
  });

  it('E6. instalação de uma tentativa frustrada não vale para a próxima', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s, { requiresInstallation: true })).body;
    const andre = await k.andreTablet(s);
    let v = await k.toDestination(andre, d);
    v = (
      await post(andre, `/api/v1/deliveries/${d.id}/install`, {
        note: 'Instalada',
        complete: true,
        version: v,
      })
    ).body.version;
    const fr = await post(andre, `/api/v1/deliveries/${d.id}/frustrate`, {
      kind: 'CLIENTE_INDISPONIVEL',
      reason: 'Cliente desistiu de receber hoje',
      version: v,
    });
    expect(fr.status).toBe(200);
    const again = await s.admin.put(`/api/v1/deliveries/${d.id}`, {
      scheduledDate: day(3),
      windowStart: '14:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: s.ids.andre,
      requiresInstallation: true,
      itemIds: [s.sofa.id],
      reason: 'Nova data',
      version: fr.body.version,
    });
    expect(again.status).toBe(200);
    v = await k.toDestination(andre, again.body);
    v = (
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      })
    ).body.version;
    const done = await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: v });
    expect(done.status).toBe(422);
  });

  it('E8. detalhe da entrega concluída não lista peça retirada antes da saída', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    const d = (await k.schedule(s, { itemIds: [s.sofa.id, s.poltronas.id] })).body;
    const u = await s.admin.put(`/api/v1/deliveries/${d.id}`, {
      scheduledDate: day(1),
      windowStart: '09:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: s.ids.andre,
      itemIds: [s.sofa.id],
      reason: 'Poltronas ficam para a próxima',
      version: d.version,
    });
    expect(u.status).toBe(200);
    const andre = await k.andreTablet(s);
    let v = await k.toDestination(andre, u.body);
    v = (
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      })
    ).body.version;
    expect((await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: v })).status).toBe(
      200,
    );
    const full = (await s.admin.get(`/api/v1/deliveries/${d.id}`)).body;
    const ids = (full.items as { serviceOrderItemId?: string; id?: string }[]).map(
      (i) => i.serviceOrderItemId ?? i.id,
    );
    expect(ids).toEqual([s.sofa.id]);
  });
});

describe('Contraprova — embalagem pelo gestor', () => {
  it('QE. embalagem sem responsável (ninguém disponível) pode ser concluída pelo gestor', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await k.approveOpen(s, s.sofa.id);
    const p = (await db().packagingRecord.findFirstOrThrow({
      where: { serviceOrderItemId: s.sofa.id },
    }))!;
    const task = await db().productionTask.findUniqueOrThrow({ where: { id: p.taskId! } });
    expect(task.assigneeUserId).toBeNull(); // ninguém marcou chegada: aguarda o gestor
    await k.pack(s, s.sofa.id); // gestor conclui
    const done = await db().productionTask.findUniqueOrThrow({ where: { id: p.taskId! } });
    expect(done).toMatchObject({ status: 'CONCLUIDA', assigneeUserId: s.ids.gestor });
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
  });
});

// ─────────────────────────── Aceites ───────────────────────────

const moneyKeys = (o: unknown): string[] => {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v && typeof v === 'object')
      for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        if (/cents|price|valor|margin|amount/i.test(key)) out.push(`${path}.${key}`);
        walk(val, `${path}.${key}`);
      }
  };
  walk(o, '$');
  return out;
};

describe('Aceites — qualidade (1–17)', () => {
  it('1–9. produção concluída aguarda qualidade; Thiago padrão; substituto; aprovação e reprovação rastreáveis', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    // 1–2. produção terminada ≠ pronta: aguarda a inspeção, nada é agendável.
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_INSPECAO');
    expect((await k.schedule(s)).status).toBe(422);
    // 3. responsável padrão pela configuração (inspetor principal = Thiago no cadastro inicial).
    const open = (await k.openOf(s.sofa.id))!;
    expect(open.inspectorUserId).toBe(s.ids.thiago);
    // 4. substituto autorizado pelo gestor (sem alterar o passado).
    await grant(s.admin, 'João', ['qualidade.inspecionar']);
    const sub = await post(s.admin, `/api/v1/quality/inspections/${open.id}/assign`, {
      inspectorUserId: s.ids.joao,
      reason: 'Thiago na entrega',
      version: open.version,
    });
    expect(sub.status).toBe(200);
    expect((await k.openOf(s.sofa.id))!.inspectorUserId).toBe(s.ids.joao);
    // 5. quem não tem permissão não aprova.
    const i = await k.checkAll(s.admin, open.id);
    const denied = await post(s.tablets.Márcio!, `/api/v1/quality/inspections/${i.id}/approve`, {
      version: i.version,
    });
    expect(denied.status).toBe(403);
    // 8–9. reprovação registra problema, autor e hora; a peça deixa de estar apta.
    const bad = await k.checkAll(s.admin, open.id, 'Costura solta no braço');
    const rej = await post(s.admin, `/api/v1/quality/inspections/${bad.id}/reject`, {
      reason: 'Costura do braço com ponto solto',
      version: bad.version,
    });
    expect(rej.status).toBe(200);
    const r1 = await db().qualityInspection.findUniqueOrThrow({ where: { id: open.id } });
    expect(r1).toMatchObject({ status: 'REPROVADA', decidedById: s.ids.gestor });
    expect(r1.decidedAt).not.toBeNull();
    expect(r1.decisionNote).toMatch(/ponto solto/);
    expect(await k.stage(s.sofa.id)).toBe('EM_CORRECAO');
    // 6–7. a correção concluída gera nova rodada; a aprovação registra responsável, data e versão.
    const corr = await db().productionTask.findFirstOrThrow({
      where: { inspectionId: open.id, activity: 'CORRECAO' },
    });
    await k.finish(s.tablets.Ricardo!, corr.id, 'Costura refeita');
    const round2 = (await k.openOf(s.sofa.id))!;
    expect(round2).toMatchObject({ round: 2, reason: 'CORRECAO_CONCLUIDA' });
    const ok = await k.checkAll(s.admin, round2.id);
    expect(
      (await post(s.admin, `/api/v1/quality/inspections/${ok.id}/approve`, { version: ok.version }))
        .status,
    ).toBe(200);
    const r2 = await db().qualityInspection.findUniqueOrThrow({ where: { id: round2.id } });
    expect(r2).toMatchObject({ status: 'APROVADA', decidedById: s.ids.gestor });
    expect(r2.osRevision).not.toBeNull();
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_EMBALAGEM');
    await k.pack(s, s.sofa.id);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
  });

  it('10–15. retrabalho preserva a execução anterior, não gera pagamento, impede entrega e volta à qualidade', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const payablesBefore = await db().productionPayable.count();
    const open = (await k.openOf(s.sofa.id))!;
    const bad = await k.checkAll(s.tablets.Thiago!, open.id, 'Mancha no assento');
    await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${bad.id}/reject`, {
      reason: 'Mancha no assento',
      version: bad.version,
    });
    // 10. a etapa original continua concluída (nada reaberto nem apagado).
    expect(
      (await db().productionTask.findUniqueOrThrow({ where: { id: s.sofaTask.id } })).status,
    ).toBe('CONCLUIDA');
    // 11. a correção nasce liberada para quem fez a peça.
    const corr = await db().productionTask.findFirstOrThrow({
      where: { inspectionId: open.id, activity: 'CORRECAO' },
    });
    expect(corr).toMatchObject({ status: 'LIBERADA', assigneeUserId: s.ids.ricardo });
    // 12. retrabalho não cria pagamento nem obrigação nova.
    expect(await db().productionPayable.count()).toBe(payablesBefore);
    // 13. em retrabalho não pode ser agendada (nem provisória vira definitiva).
    expect((await k.schedule(s)).status).toBe(422);
    // 14–15. concluída a correção, volta à qualidade; só a nova aprovação libera.
    await k.finish(s.tablets.Ricardo!, corr.id, 'Limpeza feita');
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_INSPECAO');
    await k.approveOpen(s, s.sofa.id);
    await k.pack(s, s.sofa.id);
    expect((await k.schedule(s)).status).toBe(201);
    expect(await db().productionPayable.count()).toBe(payablesBefore);
    const rounds = await db().qualityInspection.findMany({
      where: { serviceOrderItemId: s.sofa.id },
      orderBy: { round: 'asc' },
    });
    expect(rounds.map((r) => r.status)).toEqual(['REPROVADA', 'APROVADA']);
  });

  it('16–17. duas aprovações e aprovar × reprovar simultâneos: uma decisão só', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const i = await k.checkAll(s.tablets.Thiago!, (await k.openOf(s.sofa.id))!.id);
    const [a, b] = await Promise.all([
      post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/approve`, {
        version: i.version,
      }),
      post(s.admin, `/api/v1/quality/inspections/${i.id}/approve`, { version: i.version }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db().packagingRecord.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(1);
    // aprovar × reprovar na poltrona
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id);
    const p = await k.checkAll(s.tablets.Thiago!, (await k.openOf(s.poltronas.id))!.id, 'Risco');
    const okItems = await k.checkAll(s.admin, p.id);
    const [ap, rj] = await Promise.all([
      post(s.admin, `/api/v1/quality/inspections/${p.id}/approve`, { version: okItems.version }),
      post(s.tablets.Thiago!, `/api/v1/quality/inspections/${p.id}/reject`, {
        reason: 'Risco no braço',
        version: okItems.version,
      }),
    ]);
    expect([ap.status, rj.status].filter((x) => x === 200).length).toBeLessThanOrEqual(1);
    expect([ap.status, rj.status].every((x) => x < 500)).toBe(true);
    const decided = await db().qualityInspection.findUniqueOrThrow({ where: { id: p.id } });
    expect(['APROVADA', 'REPROVADA', 'EM_ANDAMENTO', 'PENDENTE']).toContain(decided.status);
  });
});

describe('Aceites — entrega (18–34)', () => {
  it('18–27. só peça pronta entra; gestor agenda; equipe executa; tablet sem valores; confirmação única', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    expect((await k.schedule(s)).status).toBe(422); // 18
    await k.approveOpen(s, s.sofa.id);
    await k.pack(s, s.sofa.id);
    // 21. sem permissão não agenda.
    expect(
      (await post(s.tablets.Thiago!, '/api/v1/deliveries', { customerId: await k.customerOf(s) }))
        .status,
    ).toBe(403);
    const d = await k.schedule(s); // 19–20
    expect(d.status).toBe(201);
    expect(await k.stage(s.sofa.id)).toBe('ENTREGA_AGENDADA');
    // 22–24. o responsável recebe só a própria entrega, com o necessário e sem valores.
    const andre = await k.andreTablet(s);
    const jobs = (await andre.get('/api/v1/logistics/jobs')).body as Record<string, unknown>[];
    expect(jobs.map((j) => j.id)).toEqual([d.body.id]);
    expect(jobs[0]).toMatchObject({ customerName: expect.any(String), windowStart: '09:00' });
    expect(JSON.stringify(jobs)).toMatch(/Sofá 3 lugares/);
    expect(moneyKeys(jobs)).toEqual([]);
    // 25–26. confirmação peça a peça e conclusão; repetir não duplica.
    let v = await k.toDestination(andre, d.body);
    v = (
      await post(andre, `/api/v1/deliveries/${d.body.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      })
    ).body.version;
    const [c1, c2] = await Promise.all([
      post(andre, `/api/v1/deliveries/${d.body.id}/complete`, { version: v }),
      post(andre, `/api/v1/deliveries/${d.body.id}/complete`, { version: v }),
    ]);
    expect([c1.status, c2.status].every((x) => x === 200 || x === 409)).toBe(true);
    expect(
      await db().deliveryEvent.count({ where: { deliveryId: d.body.id, kind: 'CONCLUIDA' } }),
    ).toBe(1);
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
    // 27. peça entregue não entra em outra entrega.
    expect((await k.schedule(s)).status).toBe(422);
  });

  it('28–29. tentativa frustrada não entrega; reagendamento preserva o histórico', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s)).body;
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    const fr = await post(andre, `/api/v1/deliveries/${d.id}/frustrate`, {
      kind: 'CLIENTE_INDISPONIVEL',
      reason: 'Ninguém em casa',
      version: v,
    });
    expect(fr.status).toBe(200);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    const again = await s.admin.put(`/api/v1/deliveries/${d.id}`, {
      scheduledDate: day(3),
      windowStart: '14:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: s.ids.andre,
      itemIds: [s.sofa.id],
      reason: 'Cliente pediu à tarde',
      version: fr.body.version,
    });
    expect(again.status).toBe(200);
    const kinds = (
      await db().deliveryEvent.findMany({
        where: { deliveryId: d.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['AGENDADA', 'SAIDA', 'CHEGADA', 'FRUSTRADA', 'REAGENDADA']),
    );
  });

  it('30–33. entrega parcial: só peças aptas; pedido só conclui com todas entregues', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id); // poltronas aguardando qualidade
    // 31. peça não pronta fica fora da entrega definitiva.
    expect((await k.schedule(s, { itemIds: [s.sofa.id, s.poltronas.id] })).status).toBe(422);
    const d = (await k.schedule(s, { itemIds: [s.sofa.id] })).body; // 30
    const andre = await k.andreTablet(s);
    let v = await k.toDestination(andre, d);
    v = (
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      })
    ).body.version;
    expect((await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: v })).status).toBe(
      200,
    );
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
    expect(await k.stage(s.poltronas.id)).toBe('AGUARDANDO_INSPECAO');
    expect(await orderState(s)).not.toBe('SERVICO_CONCLUIDO'); // 32
    // 33. a última peça entregue fecha o ciclo físico.
    await k.approveOpen(s, s.poltronas.id);
    await k.pack(s, s.poltronas.id);
    const d2 = (await k.schedule(s, { itemIds: [s.poltronas.id] })).body;
    v = await k.toDestination(andre, d2);
    v = (
      await post(andre, `/api/v1/deliveries/${d2.id}/items`, {
        items: [{ serviceOrderItemId: s.poltronas.id, status: 'ENTREGUE' }],
        version: v,
      })
    ).body.version;
    expect((await post(andre, `/api/v1/deliveries/${d2.id}/complete`, { version: v })).status).toBe(
      200,
    );
    expect(await orderState(s)).toBe('SERVICO_CONCLUIDO');
  });

  it('34. entregas parciais concorrentes da mesma peça: uma só fica com a peça', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    const [a, b] = await Promise.all([
      k.schedule(s, { itemIds: [s.sofa.id] }),
      k.schedule(s, { itemIds: [s.sofa.id, s.poltronas.id] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(
      await db().deliveryItem.count({ where: { serviceOrderItemId: s.sofa.id, active: true } }),
    ).toBe(1);
  });
});

describe('Aceites — integrações (35–48)', () => {
  it('35–39. prazos, retrabalho visível, titular e apoio intactos', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const titular = (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } }))
      .upholstererUserId;
    const open = (await k.openOf(s.sofa.id))!;
    const bad = await k.checkAll(s.tablets.Thiago!, open.id, 'Botão faltando');
    await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${bad.id}/reject`, {
      reason: 'Botão faltando',
      version: bad.version,
    });
    // 35/37. o motor de prazos lê a etapa (motivo "em correção"); nada quebra.
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(2)}T00:00:00Z`) },
    });
    const so = (await s.admin.get(`/api/v1/service-orders/${s.so.id}`)).body;
    expect(so.deadline).toBeTruthy();
    expect(so.deadline).toMatchObject({ state: 'EM_RISCO', reasons: ['EM_CORRECAO'] });
    // 36. o retrabalho aparece na operação do tapeceiro.
    const mine = await s.tablets.Ricardo!.get('/api/v1/production-tasks/mine');
    expect(JSON.stringify(mine.body)).toMatch(/CORRECAO|Corre/);
    // 38. titular não muda com o retrabalho.
    expect(
      (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } }))
        .upholstererUserId,
    ).toBe(titular);
  });

  it('40, 46. custo logístico único; entrega concluída não duplica obrigação', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s, { tripCost: { amountCents: 9000 } })).body;
    const andre = await k.andreTablet(s);
    let v = await k.toDestination(andre, d);
    v = (
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      })
    ).body.version;
    await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: v });
    await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: v });
    const costs = await db().logisticsCost.findMany({ where: { deliveryId: d.id } });
    expect(costs).toHaveLength(1);
    expect(costs[0]!.status).toBe('DEVIDO');
    expect(
      await db().accountPayable.count({ where: { logisticsCost: { deliveryId: d.id } } }),
    ).toBeLessThanOrEqual(1);
    expect(
      await db().productionPayable.count({ where: { serviceOrderItemId: s.sofa.id } }),
    ).toBeLessThanOrEqual(1);
  });

  it('47–48. privacidade: eventos e avisos de qualidade/entrega sem valores', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s)).body;
    const andre = await k.andreTablet(s);
    await k.toDestination(andre, d);
    const events = await db().domainEvent.findMany({
      where: {
        OR: [
          { type: { startsWith: 'quality.' } },
          { type: { startsWith: 'delivery.' } },
          { type: { startsWith: 'item.' } },
          { type: { startsWith: 'packaging.' } },
        ],
      },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.flatMap((e) => moneyKeys(e.payload))).toEqual([]);
    const notes = await db().notification.findMany({ where: { userId: s.ids.andre } });
    expect(notes.map((n) => n.body).join(' ')).not.toMatch(/R\$/);
  });
});
