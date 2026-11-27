import { inflateRawSync } from 'node:zlib';

/**
 * Melhoria 75: leitura de planilha (Excel .xlsx ou .csv) para importar clientes e preços.
 * Sem dependência externa: o .xlsx é um zip com XML; lemos só a primeira aba e só texto e
 * números (fórmulas valem pelo último resultado salvo pelo Excel).
 */
export const MAX_SHEET_ROWS = 5000;

function unzipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // Fim do diretório central (procura de trás para frente).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('arquivo não é um .xlsx válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip inválido');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (
      !/^xl\/(sharedStrings|workbook|worksheets\/sheet\d+|_rels\/workbook)\.xml(\.rels)?$/.test(
        name,
      )
    )
      continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + size);
    if (size > 50 * 1024 * 1024) throw new Error('planilha grande demais');
    out.set(
      name,
      method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: 80 * 1024 * 1024 }),
    );
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

function textOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join('');
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(buf: Buffer): string[][] {
  const files = unzipEntries(buf);
  const shared = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  // Primeira aba (pela ordem do workbook).
  const wb = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const firstRid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
  const target = firstRid
    ? (new RegExp(`<Relationship[^>]*Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ??
      new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${firstRid}"`).exec(rels)?.[1])
    : undefined;
  const sheetName = target ? `xl/${target.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = (files.get(sheetName) ?? files.get('xl/worksheets/sheet1.xml'))?.toString('utf8');
  if (!sheet) throw new Error('planilha sem abas');
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's' && v !== undefined) value = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (v !== undefined) value = decodeXml(v);
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = value.trim();
    }
    rows.push(row);
    if (rows.length > MAX_SHEET_ROWS + 1) break;
  }
  return rows;
}

export function readCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0)
      ? ';'
      : firstLine.includes('\t')
        ? '\t'
        : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > MAX_SHEET_ROWS + 1) break;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

/** Lê .xlsx ou .csv (pelo conteúdo, não pelo nome) e devolve as linhas não vazias. */
export function readSheet(buf: Buffer): string[][] {
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  let text: string;
  if (isZip) return readXlsx(buf).filter((r) => r.some((c) => c));
  text = buf.toString('utf8');
  // Arquivo salvo pelo Excel em "CSV (separado por vírgulas)" costuma vir em Windows-1252.
  if (text.includes('�')) text = buf.toString('latin1');
  return readCsv(text).filter((r) => r.some((c) => c));
}
