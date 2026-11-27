import { Prisma, tenancyOf, type PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { requireCompanyId } from '../../core/tenant';
import { buildZip } from '../../lib/zip';

/**
 * Melhoria 99: baixar TODOS os dados da empresa num arquivo só (.zip com uma planilha CSV por
 * tabela). Passa pela trava do banco (Row-Level Security): só saem as linhas da própria empresa.
 * Senhas, PINs, tokens e segredos nunca saem; fotos e documentos ficam de fora (só os registros).
 */
const SECRET_COLUMN = /(password|pin_hash|token|secret|credential|recovery|_hash$)/i;
const SKIP_TABLES = new Set([
  'sessions',
  'email_tokens',
  'oauth_codes',
  'oauth_access_tokens',
  'audit_logs',
]);

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'bigint') s = v.toString();
  else if (Buffer.isBuffer(v)) s = '';
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  // Planilhas não executam fórmulas vindas do arquivo.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Todos os dados da empresa num .zip (uma planilha por tabela). Chamar dentro da empresa (trava
 * do banco ligada): só saem as linhas dela. Usado pela própria empresa e pelo painel da
 * plataforma ao encerrar uma empresa (item 51).
 */
export async function buildCompanyZip(prisma: PrismaClient, companyId: number) {
  const tables = Prisma.dmmf.datamodel.models
    .filter((m) => {
      const t = tenancyOf(m.name);
      return t && (t.class === 'empresa' || t.class === 'acesso' || t.class === 'empresa-raiz');
    })
    .map((m) => m.dbName ?? m.name)
    .filter((t) => !SKIP_TABLES.has(t))
    .sort();
  const files: { name: string; data: Buffer }[] = [];
  let rowsTotal = 0;
  await prisma.$transaction(async (tx) => {
    for (const table of tables) {
      const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM "${table}"${table === 'company_settings' ? ' WHERE id = $1' : ''}`,
        ...(table === 'company_settings' ? [companyId] : []),
      );
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]!).filter(
        (c) =>
          !SECRET_COLUMN.test(c) &&
          c !== 'screenshot' &&
          c !== 'logo_data_url' &&
          !(table === 'payment_proofs' && c === 'data'),
      );
      const lines = [cols.join(';'), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(';'))];
      files.push({
        name: `${table}.csv`,
        data: Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'),
      });
      rowsTotal += rows.length;
    }
  });
  const tablesCount = files.length;
  files.unshift({
    name: 'LEIA-ME.txt',
    data: Buffer.from(
      [
        'Dados da sua empresa no Cenário Gestão',
        `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
        '',
        'Cada arquivo .csv é uma planilha (abre no Excel, Google Planilhas ou LibreOffice).',
        'As colunas são separadas por ponto e vírgula. Datas estão no padrão internacional (UTC).',
        'Senhas, códigos de acesso e fotos não fazem parte deste arquivo.',
      ].join('\r\n'),
      'utf8',
    ),
  });
  return { zip: buildZip(files), tables: tablesCount, rows: rowsTotal };
}

export async function companyExportRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/v1/company/export.zip',
    { config: { access: { session: 'WEB', permissions: ['empresa.configurar'] } } },
    async (request, reply) => {
      const companyId = requireCompanyId();
      const { zip, tables, rows } = await buildCompanyZip(prisma, companyId);
      await prisma.$transaction((tx) =>
        audit(tx, actorFrom(request), {
          action: 'company.exported',
          entityType: 'company',
          entityId: String(companyId),
          summary: `Exportação completa dos dados da empresa (${tables} tabelas, ${rows} linhas).`,
        }),
      );
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="dados-empresa-${day}.zip"`)
        .header('cache-control', 'no-store')
        .send(zip);
    },
  );
}
