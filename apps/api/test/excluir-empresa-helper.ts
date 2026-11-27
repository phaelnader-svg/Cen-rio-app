import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { rawDb } from './helpers';

const SCRIPT = resolve(__dirname, '../../../packages/db/ops/excluir-empresa.sql');

/**
 * Prova que o comando de excluir uma empresa de vez (packages/db/ops/excluir-empresa.sql) consegue
 * apagar TUDO dela no estado atual do banco, sem deixar nenhum registro solto. Roda o script de
 * verdade pelo psql, mas troca o COMMIT por ROLLBACK: nada muda no banco do teste.
 */
export async function provarExclusaoDaEmpresa(empresa: number) {
  const { tradeName } = await rawDb().companySettings.findUniqueOrThrow({
    where: { id: empresa },
    select: { tradeName: true },
  });
  const sql = readFileSync(SCRIPT, 'utf8')
    .replace(/^COMMIT;$/m, 'ROLLBACK;')
    .replace("\\echo 'EMPRESA APAGADA'", "\\echo 'SIMULADO'");
  const url = process.env.DATABASE_URL!.split('?')[0]!;
  const r = spawnSync(
    'psql',
    [
      url,
      '-X',
      '-v',
      `empresa=${empresa}`,
      '-v',
      'conexoes=0',
      '-v',
      `confirmar=${tradeName}`,
      '-f',
      '-',
    ],
    { input: sql, encoding: 'utf8' },
  );
  expect(r.stderr, r.stderr).not.toMatch(/ERROR|ERRO/);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).toContain(`empresa ${empresa} apagada`);
  expect(r.stdout).toContain('SIMULADO');
  // Nada mudou de verdade (ROLLBACK).
  expect(await rawDb().companySettings.count({ where: { id: empresa } })).toBe(1);
  return r.stderr;
}
