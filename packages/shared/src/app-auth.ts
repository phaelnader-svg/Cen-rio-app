/**
 * Autorização delegada de aplicativos (OAuth 2.0 + PKCE) do Cenário Gestão.
 * Cada escopo libera um conjunto fechado de permissões; o aplicativo nunca recebe mais do que
 * o usuário que autorizou já possui (permissões efetivas = permissões do usuário ∩ escopos).
 * Ações exclusivas do tablet (iniciar/concluir etapa) e de administração nunca são liberadas.
 */
import type { Permission } from './permissions';

export interface AppScopeDef {
  label: string;
  description: string;
  permissions: readonly Permission[];
}

export const APP_SCOPES = {
  jogo: {
    label: 'Planta e agentes',
    description:
      'Sincronizar a planta da oficina e do escritório, estações, personagens e agentes de IA.',
    permissions: [
      'painel.acessar',
      'jogo.acessar',
      'jogo.construir',
      'agentes.usar',
      'agentes.gerenciar',
    ],
  },
  operacao: {
    label: 'Operação da oficina',
    description:
      'Ver e planejar OS, etapas, funcionários, materiais, estoque, reservas e compras. Iniciar a execução continua sendo confirmado pelo funcionário no tablet.',
    permissions: [
      'painel.acessar',
      'os.ver',
      'os.gerenciar',
      'pedidos.ver',
      'producao.ver',
      'producao.planejar',
      'funcionarios.ver',
      'presenca.ver',
      'materiais.ver',
      'estoque.ver',
      'estoque.gerenciar',
      'compras.ver',
      'compras.gerenciar',
      'clientes.ver',
      'entregas.ver',
      'ocorrencias.ver',
      'retiradas.ver',
      'qualidade.inspecionar',
    ],
  },
  escritorio: {
    label: 'Escritório e financeiro',
    description:
      'Ver o caixa, cobranças, contratos, notas, entregas e atendimento; propor ações que você aprova antes de enviar, pagar ou emitir.',
    permissions: [
      'painel.acessar',
      'financeiro.ver',
      'financeiro.gerenciar',
      'pedidos.valores',
      'clientes.gerenciar',
      'entregas.gerenciar',
      'atendimento.ver',
      'atendimento.responder',
      'marketing.publicar',
      'anuncios.gerenciar',
      'conexoes.gerenciar',
      'empresa.ver',
    ],
  },
} as const satisfies Record<string, AppScopeDef>;

export type AppScope = keyof typeof APP_SCOPES;
export const APP_SCOPE_KEYS = Object.keys(APP_SCOPES) as AppScope[];

export function parseScopes(raw: string | string[] | null | undefined): AppScope[] {
  const list = Array.isArray(raw) ? raw : (raw ?? '').split(/[\s,]+/);
  return [...new Set(list.filter((s): s is AppScope => s in APP_SCOPES))];
}

/** Permissões que os escopos podem liberar (antes da interseção com as do usuário). */
export function scopePermissions(scopes: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) {
    const def = (APP_SCOPES as Record<string, AppScopeDef>)[s];
    if (def) for (const p of def.permissions) out.add(p);
  }
  return out;
}

/** Validade do token de acesso e do token de renovação. */
export const APP_ACCESS_TTL_SECONDS = 3600;
export const APP_REFRESH_TTL_DAYS = 90;
export const APP_CODE_TTL_SECONDS = 300;
