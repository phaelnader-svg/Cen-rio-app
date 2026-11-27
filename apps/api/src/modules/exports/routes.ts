/**
 * Exportar para planilha (CSV com ponto e vírgula, abre no Excel): clientes, pedidos comerciais e
 * ordens de serviço da empresa. Cada lista exige a mesma permissão de ver a tela. A trava por
 * empresa do banco garante que só saem os dados da própria empresa.
 */
import {
  CUSTOMER_KIND_LABEL,
  NUMBER_PREFIX,
  ORDER_STATUS_LABEL,
  PRIORITY_LABEL,
  SERVICE_ORDER_STATUS_LABEL,
  csvMoney,
  formatNumber,
  toCsv,
} from '@cenario/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');

function sendCsv(reply: FastifyReply, name: string, csv: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}-${day(new Date())}.csv"`)
    .send(csv);
}

export async function exportRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/v1/export/clientes.csv',
    { config: { access: { session: 'WEB', permissions: ['clientes.ver'] } } },
    async (_request, reply) => {
      const rows = await prisma.customer.findMany({
        orderBy: { name: 'asc' },
        include: { addresses: { take: 1, orderBy: { createdAt: 'asc' } } },
      });
      const header = [
        'Nome',
        'Tipo',
        'Nome fantasia',
        'CPF/CNPJ',
        'Telefone',
        'WhatsApp',
        'E-mail',
        'Endereço',
        'Ativo',
        'Cadastrado em',
      ];
      const data = rows.map((c) => {
        const a = c.addresses[0] as Record<string, unknown> | undefined;
        const address = a
          ? ['street', 'number', 'district', 'city', 'state']
              .map((k) => a[k])
              .filter((v) => typeof v === 'string' && v)
              .join(', ')
          : '';
        return [
          c.name,
          CUSTOMER_KIND_LABEL[c.kind],
          c.tradeName,
          c.document,
          c.phone,
          c.whatsapp,
          c.email,
          address,
          c.active ? 'Sim' : 'Não',
          day(c.createdAt),
        ];
      });
      return sendCsv(reply, 'clientes', toCsv(header, data));
    },
  );

  app.get(
    '/api/v1/export/pedidos.csv',
    { config: { access: { session: 'WEB', permissions: ['pedidos.ver'] } } },
    async (_request, reply) => {
      const rows = await prisma.commercialOrder.findMany({
        orderBy: { number: 'asc' },
        include: { customer: { select: { name: true } } },
      });
      const header = [
        'Pedido',
        'Cliente',
        'Serviço contratado',
        'Situação',
        'Valor combinado (R$)',
        'Condições de pagamento',
        'Prazo prometido',
        'Criado em',
      ];
      const data = rows.map((o) => [
        formatNumber(NUMBER_PREFIX.order, o.number),
        o.customer.name,
        o.contractedService,
        ORDER_STATUS_LABEL[o.status],
        csvMoney(o.agreedValueCents),
        o.paymentTerms,
        day(o.promisedDate),
        day(o.createdAt),
      ]);
      return sendCsv(reply, 'pedidos', toCsv(header, data));
    },
  );

  app.get(
    '/api/v1/export/os.csv',
    { config: { access: { session: 'WEB', permissions: ['os.ver'] } } },
    async (_request, reply) => {
      const rows = await prisma.serviceOrder.findMany({
        orderBy: { number: 'asc' },
        include: {
          customer: { select: { name: true } },
          order: { select: { number: true, contractedService: true } },
          _count: { select: { items: true } },
        },
      });
      const header = [
        'OS',
        'Pedido',
        'Cliente',
        'Serviço',
        'Peças',
        'Situação',
        'Prioridade',
        'Prazo prometido',
        'Criada em',
      ];
      const data = rows.map((s) => [
        formatNumber(NUMBER_PREFIX.serviceOrder, s.number),
        formatNumber(NUMBER_PREFIX.order, s.order.number),
        s.customer.name,
        s.order.contractedService,
        s._count.items,
        SERVICE_ORDER_STATUS_LABEL[s.status],
        PRIORITY_LABEL[s.priority],
        day(s.promisedDate),
        day(s.createdAt),
      ]);
      return sendCsv(reply, 'ordens-de-servico', toCsv(header, data));
    },
  );
}
