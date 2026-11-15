import { describe, expect, it } from 'vitest';
import {
  type LayoutContent,
  askMestre,
  buildGrid,
  clearanceAround,
  findPath,
  footprint,
  furnitureModel,
  materialTone,
  placePiece,
  removalImpacts,
  sofaRoute,
  suggestedOffice,
  suggestedWorkshop,
} from '../src';

const team = [
  { userId: '00000000-0000-4000-a000-000000000001', displayName: 'João' },
  { userId: '00000000-0000-4000-a000-000000000002', displayName: 'Márcio' },
  { userId: '00000000-0000-4000-a000-000000000003', displayName: 'Ricardo' },
  { userId: '00000000-0000-4000-a000-000000000004', displayName: 'Thiago' },
];
const [JOAO, MARCIO, RICARDO] = team.map((t) => t.userId) as [string, string, string];
const clone = (l: LayoutContent) => JSON.parse(JSON.stringify(l)) as LayoutContent;

describe('planta sugerida', () => {
  it('oficina com ~180 m², medidas ilustrativas e fluxo até a expedição livre para sofá', () => {
    const w = suggestedWorkshop(team);
    expect((w.widthCm * w.depthCm) / 10000).toBe(180);
    expect(w.illustrative).toBe(true);
    for (const fn of [
      'RECEBIMENTO',
      'DESMANCHE',
      'CORTE',
      'COSTURA',
      'MARCENARIA',
      'MONTAGEM',
      'QUALIDADE',
      'EMBALAGEM',
      'EXPEDICAO',
      'ESTOQUE',
    ])
      expect(w.areas.some((a) => a.function === fn)).toBe(true);
    expect(sofaRoute(w)).not.toBeNull();
    expect(w.stations.find((s) => s.name === 'Bancada do Ricardo')!.assigneeUserIds).toEqual([
      RICARDO,
    ]);
  });

  it('ids únicos e estáveis entre áreas, estações e posições', () => {
    const w = suggestedWorkshop(team);
    const ids = [
      ...w.areas,
      ...w.stations,
      ...w.storageUnits,
      ...w.storageUnits.flatMap((u) => u.slots),
    ].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('posição representada da peça (só pelos registros)', () => {
  const l = suggestedWorkshop(team);
  const desmanche = l.stations.find((s) => s.name === 'Bancada do desmanche')!;
  const corte = l.stations.find((s) => s.kind === 'MESA_CORTE')!;
  const t = (id: string, activity: string, status: string, assigneeUserId: string | null) => ({
    id,
    activity,
    status,
    assigneeUserId,
  });

  it('sem planejamento → recebimento', () => {
    expect(placePiece(l, { stage: 'EM_PRODUCAO', tasks: [] }).kind).toBe('SEM_PLANEJAMENTO');
  });
  it('atribuído e liberado → fila do João, junto da estação dele', () => {
    const p = placePiece(l, {
      stage: 'EM_PRODUCAO',
      tasks: [t('a', 'DESMONTAGEM', 'LIBERADA', JOAO)],
      names: { [JOAO]: 'João' },
    });
    expect(p).toMatchObject({ kind: 'FILA', userId: JOAO, stationId: desmanche.id });
    expect(p.label).toContain('fila de João');
  });
  it('João iniciou → estação do João; concluiu → aguardando a etapa seguinte', () => {
    expect(
      placePiece(l, { stage: 'EM_PRODUCAO', tasks: [t('a', 'DESMONTAGEM', 'EM_EXECUCAO', JOAO)] }),
    ).toMatchObject({ kind: 'ESTACAO', stationId: desmanche.id });
    const after = placePiece(l, {
      stage: 'EM_PRODUCAO',
      tasks: [
        t('a', 'DESMONTAGEM', 'CONCLUIDA', JOAO),
        t('b', 'CORTE_TECIDO', 'BLOQUEADA', MARCIO),
      ],
    });
    expect(after.kind).toBe('AGUARDANDO_ETAPA');
    expect(after.areaFunction).toBe('ESPERA');
  });
  it('Márcio inicia o corte → estação configurada para a etapa (mesa de corte compartilhada)', () => {
    const p = placePiece(l, {
      stage: 'EM_PRODUCAO',
      tasks: [
        t('a', 'DESMONTAGEM', 'CONCLUIDA', JOAO),
        t('b', 'CORTE_TECIDO', 'EM_EXECUCAO', MARCIO),
      ],
    });
    expect(p).toMatchObject({ kind: 'ESTACAO', stationId: corte.id, userId: MARCIO });
  });
  it('costura vai para a máquina vinculada ao Márcio (vínculo + etapa)', () => {
    const p = placePiece(l, {
      stage: 'EM_PRODUCAO',
      tasks: [t('c', 'COSTURA', 'EM_EXECUCAO', MARCIO)],
    });
    expect(l.stations.find((s) => s.id === p.stationId)!.name).toBe('Máquina de costura 1');
  });
  it('embalada/pronta → expedição', () => {
    expect(
      placePiece(l, { stage: 'PRONTA_ENTREGA', tasks: [t('a', 'DESMONTAGEM', 'CONCLUIDA', JOAO)] })
        .areaFunction,
    ).toBe('EXPEDICAO');
    expect(placePiece(l, { stage: 'AGUARDANDO_INSPECAO', tasks: [] }).areaFunction).toBe(
      'QUALIDADE',
    );
  });
});

describe('semáforo e modelos', () => {
  it('falta/disponível/a conferir', () => {
    expect(materialTone('COMPLETO')).toBe('DISPONIVEL');
    expect(materialTone('AGUARDANDO_COMPRA')).toBe('FALTA');
    expect(materialTone('PARCIALMENTE_DISPONIVEL')).toBe('FALTA');
    expect(materialTone('SEM_LEVANTAMENTO')).toBe('A_CONFERIR');
    expect(materialTone(null)).toBe('A_CONFERIR');
  });
  it('categorias por tipo e descrição', () => {
    expect(furnitureModel('SOFA', 'Sofá retrátil 3 lugares')).toBe('SOFA_RETRATIL');
    expect(furnitureModel('SOFA', 'Sofá de canto com chaise')).toBe('SOFA_CANTO');
    expect(furnitureModel('POLTRONA')).toBe('POLTRONA');
    expect(furnitureModel('CABECEIRA')).toBe('CABECEIRA');
  });
});

describe('caminho e passagem', () => {
  it('A* desvia de uma bancada', () => {
    const l = suggestedWorkshop(team);
    const g = buildGrid(l, { inflateCm: 20 });
    const p = findPath(g, { x: 100, y: 1100 }, { x: 1400, y: 1100 });
    expect(p).not.toBeNull();
    expect(p!.length).toBeGreaterThanOrEqual(2);
  });
  it('vão estreito entre bancadas vira aviso de passagem de sofá', () => {
    const l = clone(suggestedWorkshop(team));
    const a = l.stations.find((s) => s.name === 'Bancada do Ricardo')!;
    const b = l.stations.find((s) => s.name === 'Bancada do Márcio')!;
    b.xCm = a.xCm + a.wCm + 70; // 70 cm entre as duas
    b.yCm = a.yCm;
    const probs = clearanceAround(l, b.id, footprint(b), 0, b.rotation);
    expect(probs.some((p) => p.gapCm === 70 && /de lado/.test(p.message))).toBe(true);
  });
});

describe('Mestre de Obras', () => {
  const w = suggestedWorkshop(team);
  const o = suggestedOffice();
  it('novo tapeceiro: bancada sugerida sem travar o caminho até a expedição', () => {
    const r = askMestre(w, 'Contratei mais um tapeceiro. Onde posso montar a bancada dele?');
    const st = r.suggestion!.patch.addStations![0]!;
    expect(st.kind).toBe('BANCADA_TAPECEIRO');
    const after = clone(w);
    after.stations.push(st);
    expect(sofaRoute(after)).not.toBeNull();
    expect(r.followUp).toBe('VINCULAR_FUNCIONARIO');
  });
  it('mesa de corte perto da costura: proposta de mover', () => {
    const r = askMestre(w, 'Onde faz mais sentido colocar a mesa de corte perto da costura?');
    expect(r.suggestion!.patch.moveStations?.length).toBe(1);
  });
  it('escritório maior com mais quatro mesas: redimensiona e encaixa 4', () => {
    const r = askMestre(o, 'Mudei para um escritório maior. Como encaixo mais quatro mesas?');
    expect(r.suggestion!.patch.addStations).toHaveLength(4);
    if (r.suggestion!.patch.resize)
      expect(r.suggestion!.patch.resize.depthCm).toBeGreaterThan(o.depthCm);
  });
  it('marcenaria com caminho até a expedição (ou gargalos marcados)', () => {
    const noCarp = clone(w);
    noCarp.areas = noCarp.areas.filter((a) => a.function !== 'MARCENARIA');
    noCarp.stations = noCarp.stations.filter((s) => s.kind !== 'BANCADA_MARCENARIA');
    const r = askMestre(
      noCarp,
      'Quero criar uma área de marcenaria e deixar um caminho livre até a expedição.',
    );
    expect(r.suggestion!.patch.addAreas?.[0]?.function).toBe('MARCENARIA');
    expect(Boolean(r.suggestion!.path) || r.suggestion!.problems.length > 0).toBe(true);
  });
  it('agente de compras: usa mesa livre do escritório', () => {
    const r = askMestre(
      o,
      'Quero mais um agente para compras. Como coloco a mesa e configuro a função?',
    );
    expect(r.followUp).toBe('CONFIGURAR_AGENTE');
    expect(r.lines.join(' ')).toMatch(/Compras/);
  });
});

describe('impacto da remoção', () => {
  it('estação com funcionário e posição com material pedem destino', () => {
    const before = suggestedWorkshop(team);
    const after = clone(before);
    const bench = after.stations.find((s) => s.name === 'Bancada do Ricardo')!;
    after.stations = after.stations.filter((s) => s.id !== bench.id);
    before.storageUnits[1]!.slots[0]!.stockItemIds = ['00000000-0000-4000-a000-0000000000aa'];
    after.storageUnits = after.storageUnits.filter((u) => u.id !== before.storageUnits[1]!.id);
    const imp = removalImpacts(before, after);
    expect(imp.map((i) => i.kind).sort()).toEqual(['ESTACAO', 'POSICAO']);
    expect(
      imp
        .find((i) => i.kind === 'ESTACAO')!
        .targets.some(
          (t) => t.id === after.stations.find((s) => s.name === 'Bancada do Márcio')!.id,
        ),
    ).toBe(true);
  });
  it('área com estações dentro pede destino', () => {
    const before = suggestedWorkshop(team);
    const after = clone(before);
    const mont = after.areas.find((a) => a.function === 'MONTAGEM')!;
    after.areas = after.areas.filter((a) => a.id !== mont.id);
    expect(
      removalImpacts(before, after)
        .find((i) => i.kind === 'AREA')!
        .links.join(' '),
    ).toMatch(/estação/);
  });
});
