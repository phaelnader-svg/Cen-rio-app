/**
 * Documentos gerados pelo escritório sem dependências externas:
 * - PDF de texto (contratos) com fonte Helvetica e acentos em WinAnsi;
 * - ZIP sem compressão (pacote mensal para a contabilidade).
 */
import { crc32 } from 'node:zlib';

const WIN: Record<string, number> = {
  '€': 128,
  '–': 150,
  '—': 151,
  '‘': 145,
  '’': 146,
  '“': 147,
  '”': 148,
  '•': 149,
  '…': 133,
};
function winAnsi(s: string) {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 128 || (c >= 160 && c <= 255)) out.push(c);
    else out.push(WIN[ch] ?? 63);
  }
  return Buffer.from(out);
}
const esc = (b: Buffer) => {
  const parts: number[] = [];
  for (const x of b) {
    if (x === 0x28 || x === 0x29 || x === 0x5c) parts.push(0x5c);
    parts.push(x);
  }
  return Buffer.from(parts);
};

function wrap(text: string, max = 92) {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      lines.push('');
      continue;
    }
    let cur = '';
    for (const w of para.split(/\s+/)) {
      if ((cur + ' ' + w).trim().length > max) {
        lines.push(cur);
        cur = w;
      } else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

/** PDF A4 de texto corrido (título em negrito). */
export function textPdf(title: string, body: string): Buffer {
  const lines = wrap(body);
  const perPage = 58;
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage)
    pages.push(lines.slice(i, i + perPage));
  const objs: Buffer[] = [];
  const add = (b: Buffer | string) =>
    objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')) && objs.length;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // páginas (preenchido depois)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((pl, idx) => {
    const chunks: Buffer[] = [Buffer.from('BT\n')];
    if (idx === 0)
      chunks.push(
        Buffer.from('/F2 14 Tf 56 790 Td ('),
        esc(winAnsi(title)),
        Buffer.from(') Tj\n/F1 10 Tf 0 -26 Td\n'),
      );
    else chunks.push(Buffer.from('/F1 10 Tf 56 800 Td\n'));
    for (const l of pl)
      chunks.push(Buffer.from('('), esc(winAnsi(l)), Buffer.from(') Tj 0 -13 Td\n'));
    chunks.push(Buffer.from(`ET\nBT /F1 8 Tf 56 30 Td (${idx + 1}/${pages.length}) Tj ET\n`));
    const stream = Buffer.concat(chunks);
    const s = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
        stream,
        Buffer.from('\nendstream'),
      ]),
    );
    const p = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${s} 0 R >>`,
    );
    kids.push(p);
  });
  objs[1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
  );
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(b);
    pos += b.length;
  });
  const xref = [
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
  ].join('');
  parts.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

/** ZIP "stored" (sem compressão): suficiente para o pacote mensal. */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    h.writeUInt16LE(0, 8);
    h.writeUInt32LE(0, 10);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(f.data.length, 18);
    h.writeUInt32LE(f.data.length, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    locals.push(h, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt32LE(0, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
