import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Prisma, tenancyOf, type PrismaClient } from '@cenario/db';
import { GESTOR_ROLE_KEY } from '@cenario/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { now as clockNow } from '../../core/clock';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { refreshPlatformConfig, whatsappLink } from '../../core/platform-config';
import { runAsCompany } from '../../core/tenant';
import { Errors } from '../../lib/errors';
import { buildCompanyZip } from '../exports/company-export';
import { notifyPlatformAdmins } from '../onboarding/routes';
import { platformLog } from './admin-auth';

/**
 * Etapa 6 da lista de 53.
 *
 * Item 52: recuperar os dados de UMA empresa só. Todo dia o servidor guarda uma cópia dos dados de
 * cada empresa (uma linha por registro, em arquivo compactado na pasta de arquivos, que entra no
 * backup diário). Pelo painel da plataforma, o dono escolhe a cópia e a empresa volta para como
 * estava naquele momento, sem mexer nas outras. Antes de trocar, o sistema guarda uma cópia de
 * como está agora: dá para desfazer escolhendo essa cópia.
 *
 * Limpeza: empresa encerrada há 90 dias é apagada sozinha. Uma semana antes, aviso por e-mail
 * (para o dono da plataforma e para a empresa). Na hora de apagar, as planilhas com todos os dados
 * ficam guardadas no arquivo por 5 anos.
 *
 * As duas coisas precisam passar por cima das travas do banco (registros que não se apagam), por
 * isso usam a conexão do dono das tabelas, sempre numa transação única e conferindo no fim que
 * nenhum registro ficou apontando para algo que não existe; qualquer erro desfaz tudo.
 */

const DAY = 86_400_000;
const COPY_DIR = 'copias-empresas';
const ARCHIVE_DIR = 'arquivo-empresas';
export const KEEP_DAILY_COPIES = 14;
const KEEP_BEFORE_RESTORE_DAYS = 90;
const KEEP_ARCHIVE_YEARS = 5;
/** A cópia do dia sai depois das 3 h (horário de Brasília), com a oficina parada. */
const DAILY_COPY_HOUR = 3;
export const PURGE_NOTICE_DAYS = 7;
const LOCK_KEY = 7_263_540_052;

/** Credenciais de curta duração: apagadas na recuperação (todo mundo entra de novo). */
const EPHEMERAL = new Set([
  'sessions',
  'email_tokens',
  'oauth_codes',
  'oauth_access_tokens',
  'idempotency_keys',
  'integration_oauth_states',
]);
/**
 * Ficam como estão hoje: cobrança da assinatura (é da plataforma), fila de e-mails (não reenviar),
 * avisos do celular, eventos já processados, pedidos de privacidade e o que a empresa mandou para
 * a plataforma.
 */
const KEEP_CURRENT = new Set([
  'outbound_emails',
  'push_subscriptions',
  'domain_events',
  'integration_webhook_events',
  'subscription_invoices',
  'payment_proofs',
  'privacy_requests',
  'feedback_reports',
  'contact_requests',
  'screen_views',
]);
/** Histórico: nada sai; o que estava na cópia e não existe mais volta. */
const HISTORY = new Set(['audit_logs']);
const SECRET_COLUMN = /(password|pin_hash|token|secret|credential|recovery|_hash$)/i;

export const COPY_ID = /^\d{8}-\d{6}-(diaria|antes-de-recuperar)$/;
type CopyKind = 'diaria' | 'antes-de-recuperar';

export interface CopyHeader {
  v: 1;
  companyId: number;
  tradeName: string;
  kind: CopyKind;
  createdAt: string;
  /** Quando a empresa foi criada: a cópia só vale para ESTA empresa (mesmo número, outra base). */
  companyCreatedAt: string;
  counts: Record<string, number>;
}

/** Tabelas de uma empresa (as mesmas que saem no "Baixar os dados"). */
function companyTables(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((m) => {
      const t = tenancyOf(m.name);
      return t && (t.class === 'empresa' || t.class === 'acesso');
    })
    .map((m) => m.dbName ?? m.name)
    .sort();
}

/** Nomes amigáveis do que o dono olha antes de recuperar (o resto entra junto, sem lista). */
export const MAIN_TABLES: [string, string][] = [
  ['customers', 'Clientes'],
  ['quotes', 'Orçamentos'],
  ['commercial_orders', 'Pedidos'],
  ['service_orders', 'Ordens de serviço'],
  ['service_order_items', 'Peças'],
  ['customer_payments', 'Recebimentos'],
  ['account_payables', 'Contas a pagar'],
  ['employees', 'Funcionários'],
  ['users', 'Acessos'],
  ['attachments', 'Fotos e documentos'],
];

type Tx = Prisma.TransactionClient;

async function asOwner(tx: Tx) {
  // Conexão do dono das tabelas, sem a trava por empresa (as consultas filtram pela empresa).
  await tx.$executeRaw`SELECT set_config('role', 'none', true), set_config('app.bypass_rls', 'on', true)`;
}

async function tablesWithCompany(tx: Tx): Promise<string[]> {
  const wanted = companyTables();
  const rows = await tx.$queryRaw<{ table_name: string }[]>`
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND t.table_type = 'BASE TABLE'
       AND c.table_name = ANY(${wanted})`;
  return rows.map((r) => r.table_name).sort();
}

/** Todas as linhas da empresa, como JSON (uma string por linha), lidas numa foto só do banco. */
async function readCompanyRows(tx: Tx, companyId: number, tables: string[]) {
  const rows: Record<string, string[]> = {};
  for (const t of tables) {
    const r = await tx.$queryRawUnsafe<{ j: string }[]>(
      `SELECT to_jsonb(x)::text AS j FROM "${t}" x WHERE x.company_id = $1`,
      companyId,
    );
    if (r.length) rows[t] = r.map((x) => x.j);
  }
  return rows;
}

function stampOf(d: Date) {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function copyFolder(storageDir: string, companyId: number) {
  return join(resolve(storageDir), COPY_DIR, String(companyId));
}

async function writeCopy(
  storageDir: string,
  header: CopyHeader,
  rows: Record<string, string[]>,
): Promise<string> {
  const dir = copyFolder(storageDir, header.companyId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = `${stampOf(new Date(header.createdAt))}-${header.kind}`;
  const lines = [JSON.stringify(header)];
  for (const [t, list] of Object.entries(rows))
    for (const j of list) lines.push(`{"t":${JSON.stringify(t)},"r":${j}}`);
  const file = join(dir, `${id}.jsonl.gz`);
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, gzipSync(Buffer.from(lines.join('\n'), 'utf8')), { mode: 0o600 });
  await rename(tmp, file);
  return id;
}

async function readCopy(storageDir: string, companyId: number, id: string) {
  if (!COPY_ID.test(id)) throw Errors.notFound('Cópia');
  const file = join(copyFolder(storageDir, companyId), `${id}.jsonl.gz`);
  const buf = await readFile(file).catch(() => null);
  if (!buf) throw Errors.notFound('Cópia');
  const text = gunzipSync(buf).toString('utf8');
  const nl = text.indexOf('\n');
  const header = JSON.parse(nl < 0 ? text : text.slice(0, nl)) as CopyHeader;
  if (header.companyId !== companyId) throw Errors.notFound('Cópia');
  const rows: Record<string, string[]> = {};
  if (nl >= 0)
    for (const line of text.slice(nl + 1).split('\n')) {
      if (!line) continue;
      // {"t":"tabela","r":{...}}: separa sem refazer o JSON da linha.
      const m = /^\{"t":("(?:[^"\\]|\\.)*"),"r":/.exec(line);
      if (!m) continue;
      const t = JSON.parse(m[1]!) as string;
      (rows[t] ??= []).push(line.slice(m[0].length, -1));
    }
  return { header, rows };
}

/** Guarda a cópia de agora de uma empresa. */
export async function takeCompanyCopy(
  owner: PrismaClient,
  storageDir: string,
  companyId: number,
  kind: CopyKind,
): Promise<{ id: string; header: CopyHeader }> {
  const { header, rows } = await owner.$transaction(
    async (tx) => {
      await asOwner(tx);
      const c = await tx.companySettings.findUnique({
        where: { id: companyId },
        select: { tradeName: true, isPlatform: true, createdAt: true },
      });
      if (!c || c.isPlatform) throw Errors.notFound('Empresa');
      const rows = await readCompanyRows(tx, companyId, await tablesWithCompany(tx));
      const header: CopyHeader = {
        v: 1,
        companyId,
        tradeName: c.tradeName,
        kind,
        createdAt: clockNow().toISOString(),
        companyCreatedAt: c.createdAt.toISOString(),
        counts: Object.fromEntries(Object.entries(rows).map(([t, l]) => [t, l.length])),
      };
      return { header, rows };
    },
    { isolationLevel: 'RepeatableRead', timeout: 120_000, maxWait: 10_000 },
  );
  return { id: await writeCopy(storageDir, header, rows), header };
}

export async function listCompanyCopies(
  storageDir: string,
  companyId: number,
  companyCreatedAt?: Date,
) {
  const dir = copyFolder(storageDir, companyId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: (CopyHeader & { id: string; sizeBytes: number })[] = [];
  for (const n of names) {
    const id = n.replace(/\.jsonl\.gz$/, '');
    if (!COPY_ID.test(id) || !n.endsWith('.jsonl.gz')) continue;
    try {
      const buf = await readFile(join(dir, n));
      const text = gunzipSync(buf).toString('utf8');
      const nl = text.indexOf('\n');
      const header = JSON.parse(nl < 0 ? text : text.slice(0, nl)) as CopyHeader;
      if (companyCreatedAt && header.companyCreatedAt !== companyCreatedAt.toISOString()) continue;
      out.push({ ...header, id, sizeBytes: buf.length });
    } catch {
      // Arquivo incompleto ou estragado: fica de fora da lista.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

interface ColumnInfo {
  table_name: string;
  column_name: string;
  generated: boolean;
}

async function columnsOf(tx: Tx, tables: string[]) {
  const rows = await tx.$queryRaw<ColumnInfo[]>`
    SELECT table_name, column_name,
           (is_generated = 'ALWAYS' OR identity_generation = 'ALWAYS') AS generated
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY(${tables})`;
  const map = new Map<string, ColumnInfo[]>();
  for (const r of rows)
    (map.get(r.table_name) ?? map.set(r.table_name, []).get(r.table_name)!).push(r);
  return map;
}

/** Nenhuma linha pode ficar apontando para algo que não existe (senão, desfaz tudo). */
async function assertNoOrphans(
  tx: Tx,
  companyId: number,
  touched: Set<string>,
  withCompany: Set<string>,
) {
  const fks = await tx.$queryRaw<
    { conname: string; child: string; parent: string; ccols: string[]; pcols: string[] }[]
  >`
    SELECT c.conname, cr.relname AS child, pr.relname AS parent,
           array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i) AS ccols,
           array(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.i) AS pcols
      FROM pg_constraint c
      JOIN pg_class cr ON cr.oid = c.conrelid
      JOIN pg_class pr ON pr.oid = c.confrelid
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`;
  for (const fk of fks) {
    if (!touched.has(fk.child) && !touched.has(fk.parent)) continue;
    const notNull = fk.ccols.map((c) => `f."${c}" IS NOT NULL`).join(' AND ');
    const match = fk.ccols.map((c, i) => `p."${fk.pcols[i]}" = f."${c}"`).join(' AND ');
    const own = withCompany.has(fk.child) ? ' AND f.company_id = $1' : '';
    const r = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${fk.child}" f WHERE ${notNull}${own}
         AND NOT EXISTS (SELECT 1 FROM "${fk.parent}" p WHERE ${match})`,
      ...(own ? [companyId] : []),
    );
    const n = Number(r[0]?.n ?? 0);
    if (n > 0)
      throw Errors.business(
        `Não deu para recuperar: ${n} registro(s) de ${fk.child} ficariam soltos (${fk.conname}). Nada foi mudado.`,
      );
  }
}

export interface RestoreResult {
  copyId: string;
  beforeCopyId: string;
  changes: { table: string; label: string; now: number; copy: number }[];
}

/** Item 52: a empresa volta para como estava na cópia; as outras empresas não mudam. */
export async function restoreCompanyCopy(
  owner: PrismaClient,
  storageDir: string,
  companyId: number,
  copyId: string,
  onLog: (tx: Tx, summary: string) => Promise<void>,
): Promise<RestoreResult> {
  const copy = await readCopy(storageDir, companyId, copyId);
  return owner.$transaction(
    async (tx) => {
      await asOwner(tx);
      const locked = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint * 100000 + ${companyId}::int) AS ok`;
      if (!locked[0]?.ok)
        throw Errors.conflict('Já tem uma recuperação desta empresa em andamento.');
      const c = await tx.$queryRaw<
        { trade_name: string; is_platform: boolean; created_at: Date }[]
      >`
        SELECT trade_name, is_platform, created_at FROM company_settings WHERE id = ${companyId} FOR UPDATE`;
      if (!c[0] || c[0].is_platform) throw Errors.notFound('Empresa');
      if (copy.header.companyCreatedAt !== c[0].created_at.toISOString())
        throw Errors.business('Esta cópia é de outra empresa com o mesmo número. Nada foi mudado.');
      const tables = await tablesWithCompany(tx);
      const withCompany = new Set(tables);

      // 1) Antes de trocar: a cópia de como está agora (dá para desfazer).
      const current = await readCompanyRows(tx, companyId, tables);
      const beforeHeader: CopyHeader = {
        v: 1,
        companyId,
        tradeName: c[0].trade_name,
        kind: 'antes-de-recuperar',
        createdAt: clockNow().toISOString(),
        companyCreatedAt: c[0].created_at.toISOString(),
        counts: Object.fromEntries(Object.entries(current).map(([t, l]) => [t, l.length])),
      };
      const beforeCopyId = await writeCopy(storageDir, beforeHeader, current);

      // 2) Troca, com as travas desligadas só nesta transação.
      await tx.$executeRaw`SELECT set_config('session_replication_role', 'replica', true)`;
      const cols = await columnsOf(tx, tables);
      const touched = new Set<string>();
      for (const t of tables) {
        if (KEEP_CURRENT.has(t) || HISTORY.has(t)) continue;
        await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE company_id = $1`, companyId);
        touched.add(t);
      }
      for (const t of tables) {
        if (KEEP_CURRENT.has(t) || EPHEMERAL.has(t)) continue;
        const list = copy.rows[t];
        if (!list?.length) continue;
        const keys = new Set(Object.keys(JSON.parse(list[0]!) as object));
        const names = (cols.get(t) ?? [])
          .filter((col) => !col.generated && keys.has(col.column_name))
          .map((col) => `"${col.column_name}"`)
          .join(', ');
        const tail = HISTORY.has(t) ? ' ON CONFLICT DO NOTHING' : '';
        for (let i = 0; i < list.length; i += 500)
          await tx.$executeRawUnsafe(
            `INSERT INTO "${t}" (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::"${t}", $1::jsonb)${tail}`,
            `[${list.slice(i, i + 500).join(',')}]`,
          );
        touched.add(t);
      }
      // Senhas e códigos de acesso continuam os de hoje (ninguém volta para uma senha antiga).
      for (const t of tables) {
        if (KEEP_CURRENT.has(t) || EPHEMERAL.has(t) || !current[t]?.length) continue;
        const secret = (cols.get(t) ?? [])
          .map((col) => col.column_name)
          .filter((n) => SECRET_COLUMN.test(n));
        if (!secret.length || !(cols.get(t) ?? []).some((col) => col.column_name === 'id'))
          continue;
        await tx.$executeRawUnsafe(
          `UPDATE "${t}" t SET ${secret.map((n) => `"${n}" = s."${n}"`).join(', ')}
             FROM jsonb_populate_recordset(NULL::"${t}", $1::jsonb) s
            WHERE t.id = s.id AND t.company_id = $2`,
          `[${current[t]!.join(',')}]`,
          companyId,
        );
      }
      await tx.$executeRaw`SELECT set_config('session_replication_role', 'origin', true)`;
      await assertNoOrphans(tx, companyId, touched, withCompany);

      const changes = MAIN_TABLES.map(([table, label]) => ({
        table,
        label,
        now: current[table]?.length ?? 0,
        copy: copy.rows[table]?.length ?? 0,
      }));
      await onLog(
        tx,
        `${c[0].trade_name}: dados recuperados da cópia de ${fmtDateTime(copy.header.createdAt)}. Como estava antes ficou guardado (${beforeCopyId}).`,
      );
      return { copyId, beforeCopyId, changes };
    },
    { timeout: 300_000, maxWait: 10_000 },
  );
}

const fmtDay = (d: Date | string) =>
  new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtDateTime = (d: Date | string) =>
  new Date(d).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Apaga de vez uma empresa (como packages/db/ops/excluir-empresa.sql), numa transação só. */
async function deleteCompany(tx: Tx, companyId: number) {
  const tables = await tablesWithCompany(tx);
  await tx.$executeRaw`SELECT set_config('session_replication_role', 'replica', true)`;
  for (const t of tables)
    await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE company_id = $1`, companyId);
  await tx.$executeRaw`DELETE FROM company_settings WHERE id = ${companyId}`;
  await tx.$executeRaw`SELECT set_config('session_replication_role', 'origin', true)`;
  // Nada de nenhuma tabela pode ter ficado apontando para a empresa ou para os dados dela.
  const touched = new Set([...tables, 'company_settings']);
  await assertNoOrphans(tx, companyId, touched, new Set());
}

function archiveFolder(storageDir: string) {
  return join(resolve(storageDir), ARCHIVE_DIR);
}

export async function listArchives(storageDir: string) {
  const names = await readdir(archiveFolder(storageDir)).catch(() => [] as string[]);
  const out: { name: string; tradeName: string | null; sizeBytes: number; createdAt: string }[] =
    [];
  for (const name of names) {
    if (!ARCHIVE_NAME.test(name)) continue;
    const s = await stat(join(archiveFolder(storageDir), name)).catch(() => null);
    if (!s) continue;
    // Ao lado do .zip, o nome da empresa como estava (com acentos).
    const info = await readFile(join(archiveFolder(storageDir), `${name}.json`), 'utf8')
      .then((t) => JSON.parse(t) as { tradeName?: string })
      .catch(() => null);
    out.push({
      name,
      tradeName: info?.tradeName ?? null,
      sizeBytes: s.size,
      createdAt: s.mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export const ARCHIVE_NAME = /^empresa-\d+-[a-z0-9-]{1,60}-\d{4}-\d{2}-\d{2}\.zip$/;

function slug(s: string) {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'empresa'
  );
}

async function ownerEmails(system: PrismaClient, companyId: number) {
  return runAsCompany(companyId, () =>
    system.user.findMany({
      where: {
        companyId,
        active: true,
        email: { not: null },
        supportAgent: false,
        roles: { some: { role: { key: GESTOR_ROLE_KEY } } },
      },
      select: { email: true, displayName: true },
    }),
  );
}

let roundRunning = false;

export interface CopiesRoundDeps {
  owner: PrismaClient;
  system: PrismaClient;
  storageDir: string;
  webUrl: string;
  log: FastifyBaseLogger;
}

/**
 * Rodada diária (chamada a cada meia hora; só faz o que ainda não foi feito hoje):
 * cópia de cada empresa ativa, limpeza das cópias antigas, aviso de 7 dias e exclusão das
 * empresas encerradas há 90 dias.
 */
export async function companyCopiesRound(
  d: CopiesRoundDeps,
): Promise<{ copies: number; purged: number; notices: number }> {
  const result = { copies: 0, purged: 0, notices: 0 };
  // Uma rodada por vez (a API roda numa instância só; a recuperação tem a sua própria trava).
  if (roundRunning) return result;
  roundRunning = true;
  try {
    // O WhatsApp da plataforma (botão do aviso) vem do painel.
    await refreshPlatformConfig(d.system);
    const now = clockNow();
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(now),
    );
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
    const companies = await d.system.companySettings.findMany({
      where: { isPlatform: false },
      select: {
        id: true,
        createdAt: true,
        tradeName: true,
        email: true,
        closedAt: true,
        purgeAfter: true,
        serverConnections: true,
      },
    });
    for (const c of companies) {
      try {
        if (!c.closedAt && hour >= DAILY_COPY_HOUR) {
          const copies = await listCompanyCopies(d.storageDir, c.id, c.createdAt);
          const hasToday = copies.some(
            (x) =>
              x.kind === 'diaria' &&
              new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
                new Date(x.createdAt),
              ) === today,
          );
          if (!hasToday) {
            await takeCompanyCopy(d.owner, d.storageDir, c.id, 'diaria');
            result.copies++;
          }
          await pruneCopies(d.storageDir, c.id, now);
        }
        if (c.closedAt && c.purgeAfter) {
          const left = c.purgeAfter.getTime() - now.getTime();
          if (left <= 0) {
            if (await purgeCompany(d, c.id)) result.purged++;
          } else if (left <= PURGE_NOTICE_DAYS * DAY) {
            if (await purgeNotice(d, c)) result.notices++;
          }
        }
      } catch (err) {
        d.log.warn({ err, companyId: c.id }, 'Falha na cópia ou limpeza da empresa');
      }
    }
    await pruneArchives(d.storageDir, now);
  } finally {
    roundRunning = false;
  }
  return result;
}

async function pruneCopies(storageDir: string, companyId: number, now: Date) {
  const copies = await listCompanyCopies(storageDir, companyId);
  const daily = copies.filter((x) => x.kind === 'diaria');
  const drop = [
    ...daily.slice(KEEP_DAILY_COPIES),
    ...copies.filter(
      (x) =>
        x.kind === 'antes-de-recuperar' &&
        now.getTime() - Date.parse(x.createdAt) > KEEP_BEFORE_RESTORE_DAYS * DAY,
    ),
  ];
  for (const x of drop)
    await rm(join(copyFolder(storageDir, companyId), `${x.id}.jsonl.gz`), { force: true });
}

async function pruneArchives(storageDir: string, now: Date) {
  for (const a of await listArchives(storageDir))
    if (now.getTime() - Date.parse(a.createdAt) > KEEP_ARCHIVE_YEARS * 365 * DAY)
      for (const f of [a.name, `${a.name}.json`])
        await rm(join(archiveFolder(storageDir), f), { force: true });
}

/** Uma semana antes: aviso para o dono da plataforma e para a empresa (uma vez só). */
async function purgeNotice(
  d: CopiesRoundDeps,
  c: { id: number; tradeName: string; email: string | null; purgeAfter: Date | null },
): Promise<boolean> {
  const done = await d.system.platformAuditLog.findFirst({
    where: { action: 'platform.company_purge_notice', targetCompanyId: c.id },
    select: { id: true },
  });
  if (done) return false;
  const when = fmtDay(c.purgeAfter!);
  await notifyPlatformAdmins(d.system, {
    subject: `${c.tradeName} vai ser apagada em ${when}`,
    title: `${c.tradeName} será apagada em ${when}`,
    paragraphs: [
      `A ${c.tradeName} está encerrada há quase 90 dias. Em ${when} o sistema apaga os dados dela sozinho.`,
      'As planilhas com todos os dados ficam guardadas no arquivo do painel por 5 anos.',
      'Se ela voltar, é só reabrir no painel antes dessa data.',
    ],
    url: `${d.webUrl}/plataforma/empresas`,
    kind: 'plataforma-empresa-apagar',
    push: `Encerrada há quase 90 dias: apaga em ${when}.`,
  });
  const owners = await ownerEmails(d.system, c.id);
  const to = new Set([c.email, ...owners.map((o) => o.email)].filter(Boolean) as string[]);
  if (to.size) {
    const first = (owners[0]?.displayName ?? '').split(/\s+/)[0] || '';
    const wa = whatsappLink(`Olá! Sou da ${c.tradeName} e quero voltar a usar o Cenário Gestão.`);
    const subject = `Os dados da ${c.tradeName} no Cenário Gestão serão apagados em ${when}`;
    const body = simpleEmail({
      title: subject,
      paragraphs: [
        `${first ? `Oi, ${first}!` : 'Oi!'} A conta da ${c.tradeName} no Cenário Gestão foi encerrada e os dados ficaram guardados por 90 dias.`,
        `Em ${when} eles serão apagados de vez. Se quiser voltar a usar ou receber uma cópia das planilhas antes disso, é só falar com a gente.`,
      ],
      ...(wa ? { button: { label: 'Falar no WhatsApp', url: wa } } : {}),
    });
    await runAsCompany(c.id, () =>
      d.system.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(c.id)}, true)`;
        for (const addr of to)
          await enqueueEmail(tx, { to: addr, subject, kind: 'empresa-sera-apagada', ...body });
      }),
    );
  }
  await d.system.platformAuditLog.create({
    data: {
      action: 'platform.company_purge_notice',
      targetCompanyId: c.id,
      summary:
        `${c.tradeName}: aviso de que será apagada em ${when} (${to.size} e-mail(s) para a empresa).`.slice(
          0,
          300,
        ),
    },
  });
  return true;
}

/** Encerrada há 90 dias: guarda as planilhas no arquivo e apaga a empresa de vez. */
export async function purgeCompany(
  d: Omit<CopiesRoundDeps, 'log'>,
  companyId: number,
): Promise<boolean> {
  const c = await d.system.companySettings.findUnique({
    where: { id: companyId },
    select: {
      tradeName: true,
      isPlatform: true,
      closedAt: true,
      purgeAfter: true,
      serverConnections: true,
    },
  });
  const now = clockNow();
  if (!c || c.isPlatform || !c.closedAt || !c.purgeAfter || c.purgeAfter.getTime() > now.getTime())
    return false;
  if (c.serverConnections) {
    // As conexões do servidor precisam passar para outra empresa antes (decisão do dono).
    return false;
  }
  // 1) Arquivo: as planilhas de tudo (o mesmo "Baixar os dados"), guardadas por 5 anos.
  const { zip, rows } = await runAsCompany(companyId, () => buildCompanyZip(d.system, companyId));
  const dir = archiveFolder(d.storageDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `empresa-${companyId}-${slug(c.tradeName)}-${now.toISOString().slice(0, 10)}.zip`;
  const file = join(dir, name);
  await writeFile(`${file}.tmp`, zip, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  await writeFile(
    `${file}.json`,
    JSON.stringify({ companyId, tradeName: c.tradeName, closedAt: c.closedAt, rows }),
    { mode: 0o600 },
  );
  // 2) Apaga, numa transação só. Os arquivos (fotos, documentos) saem depois de confirmar.
  const keys = await d.owner.$transaction(
    async (tx) => {
      await asOwner(tx);
      const files = await tx.$queryRaw<{ storage_key: string; thumb_key: string | null }[]>`
        SELECT storage_key, thumb_key FROM stored_files WHERE company_id = ${companyId}`;
      await deleteCompany(tx, companyId);
      await tx.platformAuditLog.create({
        data: {
          action: 'platform.company_deleted',
          targetCompanyId: companyId,
          summary:
            `${c.tradeName} apagada de vez (encerrada em ${fmtDay(c.closedAt!)}, 90 dias). Planilhas no arquivo: ${name}.`.slice(
              0,
              300,
            ),
        },
      });
      return files.flatMap((f) => [f.storage_key, f.thumb_key ?? '']).filter(Boolean);
    },
    { timeout: 300_000, maxWait: 10_000 },
  );
  for (const k of keys)
    if (/^[a-z0-9-]+\/[0-9a-f-]{36}$/.test(k)) {
      await rm(join(resolve(d.storageDir), k), { force: true });
    }
  await rm(copyFolder(d.storageDir, companyId), { recursive: true, force: true });
  await notifyPlatformAdmins(d.system, {
    subject: `${c.tradeName} foi apagada`,
    title: `${c.tradeName} foi apagada`,
    paragraphs: [
      `A ${c.tradeName} estava encerrada desde ${fmtDay(c.closedAt)}. Passados os 90 dias, o sistema apagou os dados dela (${rows} registros).`,
      'As planilhas com tudo ficaram guardadas no arquivo do painel (Empresas, no fim da página) por 5 anos.',
    ],
    url: `${d.webUrl}/plataforma/empresas`,
    kind: 'plataforma-empresa-apagada',
    push: false,
  });
  return true;
}

const restoreSchema = z.object({
  copyId: z.string().regex(COPY_ID),
  confirmName: z.string().min(1).max(200),
});

export async function companyCopiesRoutes(app: FastifyInstance) {
  const { owner, env } = app.ctx;
  const PLATFORM = { platform: true } as const;
  const storageDir = env.STORAGE_DIR;

  function companyId(request: FastifyRequest): number {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) throw Errors.notFound('Empresa');
    return id;
  }

  app.get(
    '/api/v1/platform/companies/:id/copies',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const c = await app.ctx.system.companySettings.findUnique({
        where: { id },
        select: { createdAt: true, isPlatform: true },
      });
      if (!c || c.isPlatform) throw Errors.notFound('Empresa');
      const copies = await listCompanyCopies(storageDir, id, c.createdAt);
      return {
        items: copies.map((x) => ({
          id: x.id,
          kind: x.kind,
          createdAt: x.createdAt,
          sizeBytes: x.sizeBytes,
          rows: Object.values(x.counts).reduce((s, n) => s + n, 0),
          main: MAIN_TABLES.map(([table, label]) => ({
            table,
            label,
            count: x.counts[table] ?? 0,
          })),
        })),
      };
    },
  );

  /** Compara a cópia com hoje (o que vai voltar e o que vai sumir), sem mudar nada. */
  app.get(
    '/api/v1/platform/companies/:id/copies/:copyId',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const { copyId } = request.params as { copyId: string };
      const { header } = await readCopy(storageDir, id, copyId);
      const nowCounts = await owner.$transaction(async (tx) => {
        await asOwner(tx);
        const out: Record<string, number> = {};
        for (const [t] of MAIN_TABLES) {
          const r = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${t}" WHERE company_id = $1`,
            id,
          );
          out[t] = Number(r[0]?.n ?? 0);
        }
        return out;
      });
      return {
        id: copyId,
        createdAt: header.createdAt,
        tradeName: header.tradeName,
        changes: MAIN_TABLES.map(([table, label]) => ({
          table,
          label,
          now: nowCounts[table] ?? 0,
          copy: header.counts[table] ?? 0,
        })),
      };
    },
  );

  app.post(
    '/api/v1/platform/companies/:id/copies',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const r = await takeCompanyCopy(owner, storageDir, id, 'diaria');
      await platformLog(app.ctx.system, request, {
        action: 'platform.company_copy',
        companyId: id,
        summary: `${r.header.tradeName}: cópia dos dados guardada agora pelo painel.`,
      });
      return { id: r.id, createdAt: r.header.createdAt };
    },
  );

  app.post(
    '/api/v1/platform/companies/:id/recover',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const input = restoreSchema.parse(request.body);
      const c = await app.ctx.system.companySettings.findUnique({
        where: { id },
        select: { tradeName: true, isPlatform: true },
      });
      if (!c || c.isPlatform) throw Errors.notFound('Empresa');
      if (input.confirmName !== c.tradeName)
        throw Errors.validation(
          { confirmName: 'O nome não confere.' },
          'Digite o nome da empresa exatamente como está, para confirmar.',
        );
      return restoreCompanyCopy(owner, storageDir, id, input.copyId, (tx, summary) =>
        platformLog(tx, request, { action: 'platform.company_recovered', companyId: id, summary }),
      );
    },
  );

  app.get('/api/v1/platform/archives', { config: { access: PLATFORM } }, async () => ({
    items: await listArchives(storageDir),
  }));

  app.get(
    '/api/v1/platform/archives/:name',
    { config: { access: PLATFORM } },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      if (!ARCHIVE_NAME.test(name)) throw Errors.notFound('Arquivo');
      const data = await readFile(join(archiveFolder(storageDir), name)).catch(() => null);
      if (!data) throw Errors.notFound('Arquivo');
      await platformLog(app.ctx.system, request, {
        action: 'platform.archive_downloaded',
        summary: `Arquivo ${name} baixado pelo painel.`,
      });
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(data);
    },
  );
}
