export class FirmaError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const E = {
  validation: (message = 'Dados inválidos.', details?: unknown) =>
    new FirmaError(400, 'VALIDATION_ERROR', message, details),
  unauthenticated: (message = 'Entre novamente para continuar.') =>
    new FirmaError(401, 'UNAUTHENTICATED', message),
  invalidCredentials: () =>
    new FirmaError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.'),
  forbidden: (message = 'Seu papel nesta organização não permite esta ação.') =>
    new FirmaError(403, 'FORBIDDEN', message),
  origin: () => new FirmaError(403, 'ORIGIN_NOT_ALLOWED', 'Origem da requisição não autorizada.'),
  notFound: (what = 'Registro') => new FirmaError(404, 'NOT_FOUND', `${what} não encontrado.`),
  conflict: (message: string, details?: unknown) =>
    new FirmaError(409, 'CONFLICT', message, details),
  versionConflict: (currentVersion: number) =>
    new FirmaError(
      409,
      'VERSION_CONFLICT',
      'Esta planta foi alterada por outra pessoa. Recarregue e tente novamente.',
      { currentVersion },
    ),
  locked: () =>
    new FirmaError(429, 'ACCOUNT_LOCKED', 'Muitas tentativas sem sucesso. Aguarde alguns minutos.'),
  /** Ação precisa de dados da empresa e a organização ainda não conectou o Cenário Gestão. */
  needsConnection: () =>
    new FirmaError(
      409,
      'CONEXAO_NECESSARIA',
      'Conecte o Cenário Gestão para ver e operar os dados da empresa (Central de Conexões → Conectar Cenário Gestão).',
    ),
  /** Autorização expirada/revogada: ações integradas suspensas até reconectar. */
  suspended: (why: string) =>
    new FirmaError(
      409,
      'CONEXAO_SUSPENSA',
      `Conexão com o Cenário Gestão suspensa: ${why} Reconecte na Central de Conexões (Reconectar Cenário Gestão). A planta e as configurações continuam disponíveis.`,
    ),
};
