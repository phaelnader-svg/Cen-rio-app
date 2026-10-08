/** Caminhos removidos dos logs estruturados (nunca registrar segredos ou credenciais). */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["idempotency-key"]',
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
