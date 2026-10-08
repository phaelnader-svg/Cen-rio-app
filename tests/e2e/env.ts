import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Lê o .env da raiz sem sobrescrever variáveis já definidas. */
export function rootEnv(fileOnly = false): Record<string, string> {
  const file = resolve(here, '../../.env');
  const out: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
  }
  if (fileOnly) return out;
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

export const E2E = {
  apiPort: 4100,
  webPort: 3100,
  admin: { email: 'gestor@e2e.local', password: 'SenhaE2E12345', name: 'Gestor E2E' },
};
