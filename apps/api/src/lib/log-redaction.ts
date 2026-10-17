/** Caminhos removidos dos logs estruturados (nunca registrar segredos ou credenciais). */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["idempotency-key"]',
  // R1 (D12): desbloqueio de "Meus Ganhos" — nunca em log.
  'req.headers["x-earnings-unlock"]',
  '*.unlockToken',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.pin',
  '*.code',
  '*.token',
  '*.passwordHash',
  '*.pinHash',
  '*.tokenHash',
  '*.credentialHash',
];
