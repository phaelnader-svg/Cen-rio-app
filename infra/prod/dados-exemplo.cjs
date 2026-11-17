/**
 * Dados de EXEMPLO para ver o Firma Viva com a oficina cheia, gravados na empresa indicada
 * (padrão: empresa 1, Cenário Estofados). Tudo leva "[Exemplo]" no nome e sai com `remover`.
 * Nunca altera nem apaga dado real: só cria linhas novas e só remove as que ele mesmo marcou.
 * Sem lançamentos financeiros: contas a pagar/receber não podem ser apagadas (trava do banco), e
 * o exemplo precisa sair inteiro. Se o jogo gravar algo permanente numa OS de exemplo (inspeção,
 * entrega…), `remover` recusa tudo e nada é apagado.
 *
 *   node dados-exemplo.cjs criar     (não faz nada se já existir exemplo)
 *   node dados-exemplo.cjs remover
 *
 * Roda dentro do contêiner `api` com o diretório de trabalho em /app/packages/db, que já tem o
 * Prisma gerado. JavaScript puro: nada é compilado no servidor.
 */
'use strict';
// Resolve o Prisma a partir do diretório de trabalho (/app/packages/db), não do lugar do arquivo.
const { PrismaClient } = require(require.resolve('@prisma/client', { paths: [process.cwd()] }));

const TAG = '[Exemplo]';
const EMPRESA = Number(process.env.EXEMPLO_EMPRESA || 1);
const modo = process.argv[2];

const EQUIPE = [
  { nome: 'Carla', cargo: 'Tapeceira', funcao: 'tapeceiro', cor: '#E11D48' },
  { nome: 'Bruno', cargo: 'Tapeceiro', funcao: 'tapeceiro', cor: '#0D9488' },
  { nome: 'Renata', cargo: 'Cabeceiras e qualidade', funcao: 'cabeceiras_qualidade', cor: '#CA8A04' },
  { nome: 'Joaquim', cargo: 'Ajudante', funcao: 'ajudante', cor: '#4F46E5' },
];

const dia = (n) => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};
const minutosAtras = (m) => new Date(Date.now() - m * 60_000);

// t: [atividade, título, status, quem]
const PEDIDOS = [
  {
    cliente: 'Mariana Lopes', tipo: 'PF', fone: '11990000001', valor: 380000, prazo: 6,
    prioridade: 'NORMAL', etapa: 'EM_PRODUCAO',
    pecas: [{ tipo: 'SOFA', desc: 'Sofá 3 lugares retrátil', qtd: 1, servico: 'REFORMA_COMPLETA', tecido: 'Linho', cor: 'Cinza grafite' }],
    tarefas: [
      ['DESMONTAGEM', 'Desmontar o sofá', 'CONCLUIDA', 'Joaquim'],
      ['COSTURA', 'Costurar capa do assento', 'EM_EXECUCAO', 'Carla'],
      ['MONTAGEM', 'Montar e revestir', 'LIBERADA', 'Carla'],
    ],
  },
  {
    cliente: 'Restaurante Sabor da Serra', tipo: 'PJ', fone: '11990000002', valor: 252000, prazo: 3,
    prioridade: 'ALTA', etapa: 'EM_PRODUCAO',
    pecas: [{ tipo: 'CADEIRA', desc: 'Cadeiras do salão', qtd: 6, servico: 'TROCA_DE_TECIDO', tecido: 'Couro sintético', cor: 'Caramelo' }],
    tarefas: [
      ['CORTE_TECIDO', 'Cortar o couro das 6 cadeiras', 'EM_EXECUCAO', 'Bruno'],
      ['REVESTIMENTO', 'Revestir as cadeiras', 'PROGRAMADA', 'Bruno'],
    ],
  },
  {
    cliente: 'Paulo Mendes', tipo: 'PF', fone: '11990000003', valor: 190000, prazo: 9,
    prioridade: 'NORMAL', etapa: 'EM_PRODUCAO',
    pecas: [{ tipo: 'CABECEIRA', desc: 'Cabeceira king capitonê', qtd: 1, servico: 'FABRICACAO', tecido: 'Veludo', cor: 'Verde musgo' }],
    tarefas: [
      ['PREPARACAO_MDF', 'Preparar a base de MDF', 'EM_EXECUCAO', 'Renata'],
      ['REVESTIMENTO', 'Revestir a cabeceira', 'LIBERADA', 'Renata'],
    ],
  },
  {
    cliente: 'Hotel Vista Alegre', tipo: 'PJ', fone: '11990000004', valor: 465000, prazo: 12,
    prioridade: 'NORMAL', etapa: 'EM_PRODUCAO',
    pecas: [{ tipo: 'CANTO_ALEMAO', desc: 'Canto alemão do café da manhã', qtd: 1, servico: 'REFORMA_COMPLETA', tecido: 'Courino', cor: 'Vinho' }],
    tarefas: [
      ['DESMONTAGEM', 'Desmontar o canto alemão', 'PAUSADA', 'Joaquim'],
      ['CORTE_ESPUMA', 'Cortar espuma nova', 'PROGRAMADA', 'Bruno'],
    ],
  },
  {
    cliente: 'Fernanda Rocha', tipo: 'PF', fone: '11990000005', valor: 98000, prazo: 2,
    prioridade: 'URGENTE', etapa: 'AGUARDANDO_INSPECAO',
    pecas: [{ tipo: 'POLTRONA', desc: 'Poltrona do escritório', qtd: 1, servico: 'TROCA_DE_ESPUMA', tecido: null, cor: null }],
    tarefas: [
      ['CORTE_ESPUMA', 'Trocar a espuma', 'CONCLUIDA', 'Carla'],
      ['ACABAMENTO', 'Acabamento final', 'CONCLUIDA', 'Carla'],
    ],
  },
  {
    cliente: 'Clínica Bem Estar', tipo: 'PJ', fone: '11990000006', valor: 64000, prazo: 1,
    prioridade: 'NORMAL', etapa: 'PRONTA_ENTREGA',
    pecas: [{ tipo: 'PUFE', desc: 'Pufes da recepção', qtd: 2, servico: 'REPARO', tecido: 'Suede', cor: 'Azul' }],
    tarefas: [['REVESTIMENTO', 'Reparar o revestimento', 'CONCLUIDA', 'Bruno']],
  },
];

async function naEmpresa(prisma, fn) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        // Mesmo papel do sistema (cenario_app, com a trava por empresa): só enxerga e grava na empresa.
        `SELECT set_config('role', 'cenario_app', true), set_config('app.company_id', '${EMPRESA}', true), set_config('app.bypass_rls', 'off', true)`,
      );
      return fn(tx);
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
}

async function criar(tx) {
  const empresa = await tx.companySettings.findUnique({ where: { id: EMPRESA } });
  if (!empresa) throw new Error(`Empresa ${EMPRESA} não encontrada.`);
  console.log(`  • empresa: ${empresa.tradeName} (nº ${EMPRESA})`);
  const ja = await tx.customer.count({ where: { name: { startsWith: TAG } } });
  if (ja) {
    console.log(`  • os dados de exemplo já existem (${ja} clientes). Nada foi criado.`);
    return;
  }
  const papeis = {};
  for (const p of await tx.role.findMany({ where: { key: { in: EQUIPE.map((e) => e.funcao) } } }))
    papeis[p.key] = p.id;
  const pessoa = {};
  for (const e of EQUIPE) {
    if (!papeis[e.funcao]) throw new Error(`Função "${e.funcao}" não existe nesta empresa.`);
    const nome = `${TAG} ${e.nome}`;
    const user = await tx.user.create({
      data: { displayName: nome, roles: { create: { roleId: papeis[e.funcao] } } },
    });
    await tx.employee.create({
      data: {
        userId: user.id, fullName: `${e.nome} (funcionário de exemplo)`, displayName: nome,
        jobTitle: e.cargo, responsibilities: 'Funcionário de exemplo para o ambiente interativo.',
        color: e.cor,
      },
    });
    pessoa[e.nome] = user.id;
  }
  console.log(`  • ${EQUIPE.length} funcionários de exemplo`);

  for (const p of PEDIDOS) {
    const nome = `${TAG} ${p.cliente}`;
    const cliente = await tx.customer.create({
      data: {
        kind: p.tipo, name: nome, phone: p.fone, whatsapp: p.fone,
        notes: 'Cliente de exemplo para o ambiente interativo.',
        searchText: `${nome} ${p.fone}`.toLowerCase(),
        addresses: {
          create: {
            label: 'Principal', street: 'Rua de Exemplo', number: String(100 + PEDIDOS.indexOf(p)),
            district: 'Centro', city: 'São Paulo', state: 'SP', isPrimary: true,
          },
        },
      },
    });
    const pedido = await tx.commercialOrder.create({
      data: {
        customerId: cliente.id, contractedService: `${TAG} ${p.pecas[0].desc}`,
        agreedValueCents: p.valor, status: 'RECEBIDO', promisedDate: dia(p.prazo),
        notes: 'Pedido de exemplo para o ambiente interativo.',
        items: {
          create: p.pecas.map((x, i) => ({
            position: i + 1, pieceType: x.tipo, description: x.desc, quantity: x.qtd,
            receivedQuantity: x.qtd, serviceType: x.servico, fabricName: x.tecido, fabricColor: x.cor,
          })),
        },
      },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    const os = await tx.serviceOrder.create({
      data: {
        orderId: pedido.id, customerId: cliente.id, promisedDate: dia(p.prazo),
        priority: p.prioridade, revenueCents: p.valor, materialsReadiness: 'COMPLETO',
        notes: 'OS de exemplo para o ambiente interativo.',
        items: {
          create: p.pecas.map((x, i) => ({
            orderItemId: pedido.items[i].id, position: i + 1, pieceType: x.tipo,
            description: `${TAG} ${x.desc}`, quantity: x.qtd, serviceType: x.servico,
            fabricName: x.tecido, fabricColor: x.cor, fulfillmentStage: p.etapa,
            upholstererUserId: pessoa[p.tarefas[p.tarefas.length - 1][3]],
          })),
        },
      },
      include: { items: true },
    });
    let seq = 0;
    for (const [atividade, titulo, status, quem] of p.tarefas) {
      seq += 1;
      const iniciou = ['EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA'].includes(status);
      await tx.productionTask.create({
        data: {
          serviceOrderId: os.id, serviceOrderItemId: os.items[0].id, activity: atividade,
          title: titulo, role: 'PRINCIPAL', assigneeUserId: pessoa[quem], priority: p.prioridade,
          sequence: seq, status, dueDate: dia(p.prazo),
          startedAt: iniciou ? minutosAtras(40 + seq * 30) : null,
          completedAt: status === 'CONCLUIDA' ? minutosAtras(10 + seq * 20) : null,
          completedById: status === 'CONCLUIDA' ? pessoa[quem] : null,
          pauseReason: status === 'PAUSADA' ? 'AGUARDANDO_ORIENTACAO' : null,
          progressPercent: status === 'EM_EXECUCAO' ? 40 : null,
          estimatedMinutes: 120,
        },
      });
    }
  }
  console.log(`  • ${PEDIDOS.length} clientes, pedidos e ordens de serviço de exemplo, com tarefas`);
}

async function remover(tx) {
  const clientes = await tx.customer.findMany({
    where: { name: { startsWith: TAG } }, select: { id: true },
  });
  const ids = clientes.map((c) => c.id);
  const oss = await tx.serviceOrder.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  const osIds = oss.map((o) => o.id);
  const t = await tx.productionTask.deleteMany({ where: { serviceOrderId: { in: osIds } } });
  await tx.serviceOrderItem.deleteMany({ where: { serviceOrderId: { in: osIds } } });
  const so = await tx.serviceOrder.deleteMany({ where: { id: { in: osIds } } });
  const pedidos = await tx.commercialOrder.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  await tx.commercialOrderItem.deleteMany({ where: { orderId: { in: pedidos.map((p) => p.id) } } });
  await tx.commercialOrder.deleteMany({ where: { customerId: { in: ids } } });
  await tx.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
  const c = await tx.customer.deleteMany({ where: { id: { in: ids } } });
  const func = await tx.employee.findMany({
    where: { displayName: { startsWith: TAG } }, select: { id: true, userId: true },
  });
  const userIds = func.map((f) => f.userId);
  await tx.employee.deleteMany({ where: { id: { in: func.map((f) => f.id) } } });
  await tx.userRole.deleteMany({ where: { userId: { in: userIds } } });
  const u = await tx.user.deleteMany({ where: { id: { in: userIds }, displayName: { startsWith: TAG } } });
  console.log(
    `  • removidos: ${c.count} clientes, ${so.count} ordens de serviço, ${t.count} tarefas, ${u.count} funcionários de exemplo`,
  );
}

(async () => {
  if (modo !== 'criar' && modo !== 'remover') throw new Error('Use: criar | remover');
  const prisma = new PrismaClient();
  try {
    await naEmpresa(prisma, modo === 'criar' ? criar : remover);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(`✖ ${e && e.message ? (e.message.match(/message: "([^"]+)"/) || [null, e.message.split('\n').pop()])[1] : e}`);
  console.error('  Nada foi gravado (tudo ou nada).');
  process.exit(1);
});
