import { ERROR_CODES, type ErrorCode } from '@cenario/shared';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (details: unknown, message = 'Dados inválidos.') =>
    new AppError(400, ERROR_CODES.VALIDATION_ERROR, message, details),
  unauthenticated: (message = 'Sessão inválida ou expirada. Entre novamente.') =>
    new AppError(401, ERROR_CODES.UNAUTHENTICATED, message),
  invalidCredentials: (message = 'Credenciais inválidas.') =>
    new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, message),
  locked: (retryAfterSeconds: number) =>
    new AppError(
      429,
      ERROR_CODES.ACCOUNT_LOCKED,
      'Muitas tentativas sem sucesso. Aguarde antes de tentar novamente.',
      { retryAfterSeconds },
      { 'retry-after': String(retryAfterSeconds) },
    ),
  forbidden: (message = 'Você não tem permissão para esta ação.') =>
    new AppError(403, ERROR_CODES.FORBIDDEN, message),
  originNotAllowed: () =>
    new AppError(403, ERROR_CODES.ORIGIN_NOT_ALLOWED, 'Origem da requisição não autorizada.'),
  deviceRequired: () =>
    new AppError(
      403,
      ERROR_CODES.DEVICE_REQUIRED,
      'Este acesso exige um dispositivo vinculado pelo gestor.',
    ),
  deviceNotAllowed: (message = 'Este funcionário não pode entrar neste dispositivo.') =>
    new AppError(403, ERROR_CODES.DEVICE_NOT_ALLOWED, message),
  notFound: (what = 'Registro') =>
    new AppError(404, ERROR_CODES.NOT_FOUND, `${what} não encontrado.`),
  conflict: (message: string, details?: unknown) =>
    new AppError(409, ERROR_CODES.CONFLICT, message, details),
  versionConflict: (currentVersion?: number) =>
    new AppError(
      409,
      ERROR_CODES.VERSION_CONFLICT,
      'Este registro foi alterado por outra pessoa. Recarregue os dados e tente novamente.',
      currentVersion === undefined ? undefined : { currentVersion },
    ),
  business: (message: string, details?: unknown) =>
    new AppError(422, ERROR_CODES.BUSINESS_RULE, message, details),
  pairingInvalid: () =>
    new AppError(
      400,
      ERROR_CODES.PAIRING_CODE_INVALID,
      'Código de vinculação inválido ou expirado. Solicite um novo código ao gestor.',
    ),
  unsupportedMedia: (message: string) =>
    new AppError(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, message),
  payloadTooLarge: (message: string) => new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, message),
};
