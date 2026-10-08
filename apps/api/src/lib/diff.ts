const SENSITIVE = new Set([
  'passwordHash',
  'pinHash',
  'tokenHash',
  'credentialHash',
  'pairingCodeHash',
  'password',
  'pin',
]);

export type ChangeSet = Record<string, { from: unknown; to: unknown }>;

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return [...value].map(normalize).sort();
  return value;
}

/** Calcula diferenças campo a campo entre dois objetos, omitindo dados sensíveis. */
export function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields?: readonly string[],
): ChangeSet {
  const keys = fields ?? [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes: ChangeSet = {};
  for (const key of keys) {
    if (SENSITIVE.has(key) || key === 'updatedAt' || key === 'version') continue;
    const from = normalize(before[key]);
    const to = normalize(after[key]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  }
  return changes;
}
