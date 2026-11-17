/**
 * Autorização delegada de aplicativos (OAuth 2.0 + PKCE) do Cenário Gestão.
 * Cada escopo libera um conjunto fechado de permissões; o aplicativo nunca recebe mais do que
 * o usuário que autorizou já possui (permissões efetivas = permissões do usuário ∩ escopos).
 * Ações exclusivas do tablet (iniciar/concluir etapa) e de administração nunca são liberadas.
 *
 * CONSULTA (somente leitura): o aplicativo vê a empresa, as OS, a produção, as entregas e o mapa
 * da oficina. JOGO: sincroniza a planta (oficina e escritório), as estações e quem trabalha em
 * cada uma; não altera OS, estoque nem financeiro. OPERAÇÃO: o dono planeja e mexe na produção
 * pelo jogo (OS, etapas, quem faz o quê, estoque e reservas) pelas mesmas regras do painel; iniciar
 * e concluir a execução continuam só no tablet do funcionário. ESCRITÓRIO: o dono conduz o
 * escritório pelo jogo (caixa, cobranças, contratos, notas, atendimento, postagens e anúncios) e
 * os agentes de IA que trabalham nele; cada ação externa segue a política de cada agente.
 */
import type { Permission } from './permissions';

export interface AppScopeDef {
  label: string;
  description: string;
  permissions: readonly Permission[];
}

export const APP_SCOPES = {
  consulta: {
    label: 'Consulta (somente leitura)',
    description:
      'Ver a empresa, as OS, a produção, as entregas e onde cada peça está na oficina. Não altera OS, estoque nem financeiro.',
    permissions: ['painel.acessar', 'empresa.ver', 'os.ver', 'producao.ver', 'entregas.ver'],
  },
  jogo: {
    label: 'Planta e pessoas',
    description:
      'Sincronizar a planta da oficina e do escritório, as estações e quem trabalha em cada uma.',
    permissions: ['painel.acessar', 'jogo.acessar', 'jogo.construir'],
  },
  operacao: {
    label: 'Operação da oficina',
    description:
      'Ver e planejar OS, etapas, funcionários, estoque e reservas. Iniciar a execução continua sendo confirmado pelo funcionário no tablet.',
    permissions: [
      'painel.acessar',
      'os.ver',
      'os.gerenciar',
      'pedidos.ver',
      'producao.ver',
      'producao.planejar',
      'funcionarios.ver',
      'presenca.ver',
      'estoque.ver',
      'estoque.gerenciar',
      'clientes.ver',
      'entregas.ver',
      'ocorrencias.ver',
      'retiradas.ver',
      'qualidade.inspecionar',
    ],
  },
  escritorio: {
    label: 'Escritório e agentes',
    description:
      'Conduzir o escritório pelo jogo: caixa, cobranças, contratos, notas fiscais, atendimento, postagens, anúncios, conexões e os agentes de IA. Nada sai para fora sem passar pelas regras de cada agente.',
    permissions: [
      'painel.acessar',
      'jogo.acessar',
      'empresa.ver',
      'financeiro.ver',
      'financeiro.gerenciar',
      'pedidos.ver',
      'pedidos.gerenciar',
      'clientes.ver',
      'atendimento.ver',
      'atendimento.responder',
      'marketing.publicar',
      'anuncios.gerenciar',
      'conexoes.gerenciar',
      'agentes.usar',
      'agentes.gerenciar',
      'orcamentos.ver',
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

export const APP_ACCESS_TTL_SECONDS = 3600;
export const APP_REFRESH_TTL_DAYS = 90;
export const APP_CODE_TTL_SECONDS = 300;
