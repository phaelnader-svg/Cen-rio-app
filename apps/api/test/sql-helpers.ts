/** Separa os comandos de um script de reversão respeitando blocos $$ … $$ (sem BEGIN/COMMIT). */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let cur = '';
  let quoted = false;
  for (const line of sql.replace(/--.*$/gm, '').split('\n')) {
    cur += line + '\n';
    quoted = quoted !== ((line.match(/\$\$/g) ?? []).length % 2 === 1);
    if (!quoted && line.trim().endsWith(';')) {
      const st = cur.trim().replace(/;$/, '');
      if (!/^(BEGIN|COMMIT)$/i.test(st)) statements.push(st);
      cur = '';
    }
  }
  return statements;
}
