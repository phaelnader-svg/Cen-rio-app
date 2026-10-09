/**
 * Catálogo de permissões do sistema.
 *
 * As permissões são definidas em código (fonte única da verdade) e sincronizadas
 * com o banco pelo seed. Funções (roles) agrupam permissões e são editáveis pelo
 * gestor; permissões individuais podem ser concedidas a um usuário específico
 * (ex.: tapeceiro autorizado a fazer medições extraordinárias em fases futuras).
 *
 * Toda verificação é feita no backend. O frontend usa este catálogo apenas para
 * esconder elementos de interface.
 */

export const PERMISSION_GROUPS = {
  acesso: 'Acesso aos ambientes',
  pessoas: 'Pessoas',
  seguranca: 'Funções e segurança',
  dispositivos: 'Dispositivos e sessões',
  empresa: 'Empresa',
  comercial: 'Clientes e pedidos',
  logistica: 'Retiradas e recebimentos',
  servicos: 'Ordens de serviço',
  compras: 'Compras e estoque',
  producao: 'Produção',
  presenca: 'Presença operacional',
  qualidade: 'Qualidade e expedição',
  financeiro: 'Financeiro operacional',
  sistema: 'Sistema',
} as const;

export type PermissionGroup = keyof typeof PERMISSION_GROUPS;

interface PermissionDefinition {
  group: PermissionGroup;
  label: string;
  description: string;
  /** Permissões críticas exigem atenção extra ao conceder (destacadas na interface). */
  critical?: boolean;
}

export const PERMISSIONS = {
  'painel.acessar': {
    group: 'acesso',
    label: 'Acessar painel administrativo',
    description: 'Permite entrar no painel administrativo pelo navegador.',
  },
  'producao.acessar': {
    group: 'acesso',
    label: 'Acessar interface de produção',
    description: 'Permite entrar na interface dos tablets da oficina.',
  },
  'funcionarios.ver': {
    group: 'pessoas',
    label: 'Ver funcionários',
    description: 'Consultar o cadastro de funcionários.',
  },
  'funcionarios.gerenciar': {
    group: 'pessoas',
    label: 'Gerenciar funcionários',
    description: 'Cadastrar, editar, desativar funcionários e redefinir credenciais de acesso.',
    critical: true,
  },
  'funcoes.ver': {
    group: 'seguranca',
    label: 'Ver funções e permissões',
    description: 'Consultar funções e as permissões atribuídas.',
  },
  'funcoes.gerenciar': {
    group: 'seguranca',
    label: 'Gerenciar funções e permissões',
    description: 'Criar e alterar funções e conceder permissões.',
    critical: true,
  },
  'dispositivos.ver': {
    group: 'dispositivos',
    label: 'Ver dispositivos',
    description: 'Consultar tablets e dispositivos cadastrados.',
  },
  'dispositivos.gerenciar': {
    group: 'dispositivos',
    label: 'Gerenciar dispositivos',
    description: 'Cadastrar, vincular, bloquear e revogar dispositivos.',
    critical: true,
  },
  'sessoes.ver': {
    group: 'dispositivos',
    label: 'Ver sessões ativas',
    description: 'Consultar sessões abertas no painel e nos tablets.',
  },
  'sessoes.revogar': {
    group: 'dispositivos',
    label: 'Revogar sessões',
    description: 'Encerrar remotamente sessões de outros usuários.',
    critical: true,
  },
  'empresa.ver': {
    group: 'empresa',
    label: 'Ver configurações da empresa',
    description: 'Consultar dados e parâmetros operacionais da empresa.',
  },
  'empresa.configurar': {
    group: 'empresa',
    label: 'Configurar empresa',
    description: 'Alterar dados e parâmetros operacionais da empresa.',
    critical: true,
  },
  'clientes.ver': {
    group: 'comercial',
    label: 'Ver clientes',
    description: 'Consultar clientes, incluindo documentos, contatos e endereços (dados pessoais).',
  },
  'clientes.gerenciar': {
    group: 'comercial',
    label: 'Gerenciar clientes',
    description: 'Cadastrar e editar clientes e seus endereços.',
    critical: true,
  },
  'pedidos.ver': {
    group: 'comercial',
    label: 'Ver pedidos comerciais',
    description: 'Consultar pedidos, peças e situação (sem valores).',
  },
  'pedidos.gerenciar': {
    group: 'comercial',
    label: 'Criar e editar pedidos',
    description: 'Criar pedidos comerciais e alterar suas informações.',
    critical: true,
  },
  'pedidos.valores': {
    group: 'comercial',
    label: 'Ver e alterar valores',
    description: 'Ver e alterar valor negociado e condições comerciais.',
    critical: true,
  },
  'pedidos.cancelar': {
    group: 'comercial',
    label: 'Cancelar pedidos',
    description: 'Cancelar pedidos comerciais.',
    critical: true,
  },
  'retiradas.ver': {
    group: 'logistica',
    label: 'Ver retiradas',
    description: 'Consultar solicitações e agenda de retiradas (endereço e contato do cliente).',
  },
  'retiradas.gerenciar': {
    group: 'logistica',
    label: 'Solicitar e agendar retiradas',
    description: 'Criar, agendar, reagendar e registrar o andamento das retiradas.',
    critical: true,
  },
  'recebimentos.registrar': {
    group: 'logistica',
    label: 'Registrar recebimento de peças',
    description: 'Registrar a chegada física das peças na oficina, com conferência.',
  },
  'os.ver': {
    group: 'servicos',
    label: 'Ver ordens de serviço',
    description: 'Consultar ordens de serviço e especificações técnicas.',
  },
  'os.gerenciar': {
    group: 'servicos',
    label: 'Criar e alterar ordens de serviço',
    description: 'Criar OS após o recebimento e alterar informações técnicas.',
    critical: true,
  },
  'medicoes.extraordinarias': {
    group: 'servicos',
    label: 'Executar medições atribuídas',
    description:
      'Tapeceiro autorizado: executa as medições que o gestor lhe atribuir (somente as próprias).',
  },
  'medicoes.gerenciar': {
    group: 'servicos',
    label: 'Gerenciar e delegar medições',
    description:
      'Criar medições (rotina de sexta e extraordinárias), atribuir responsáveis e cancelar.',
    critical: true,
  },
  'materiais.ver': {
    group: 'servicos',
    label: 'Ver solicitações e lista de materiais',
    description: 'Consultar solicitações de materiais, planejamento de sexta e lista consolidada.',
  },
  'materiais.aprovar': {
    group: 'servicos',
    label: 'Revisar e aprovar materiais',
    description:
      'Revisar quantidades, aprovar para compra ou devolver para correção. Aprovar não significa comprar.',
    critical: true,
  },
  'compras.ver': {
    group: 'compras',
    label: 'Ver compras e fornecedores',
    description: 'Consultar a central de compras, pedidos de compra, preços e fornecedores.',
  },
  'compras.gerenciar': {
    group: 'compras',
    label: 'Preparar pedidos de compra',
    description: 'Cadastrar fornecedores e montar pedidos de compra (rascunho) com preços.',
    critical: true,
  },
  'compras.aprovar': {
    group: 'compras',
    label: 'Confirmar e cancelar compras',
    description:
      'Confirmar ou cancelar pedidos de compra e autorizar recebimento acima do pedido (gestor).',
    critical: true,
  },
  'estoque.ver': {
    group: 'compras',
    label: 'Ver estoque e prontidão de materiais',
    description: 'Consultar estoque, movimentações, reservas, sobras e prontidão de materiais.',
  },
  'estoque.gerenciar': {
    group: 'compras',
    label: 'Movimentar estoque',
    description:
      'Cadastrar materiais, reservar para OS, liberar, dar saída, ajustar e registrar sobras.',
    critical: true,
  },
  'estoque.autorizar': {
    group: 'compras',
    label: 'Autorizar estornos e transferências',
    description:
      'Estornar recebimentos de materiais e transferir sobras de tecido entre OS (gestor).',
    critical: true,
  },
  'producao.ver': {
    group: 'producao',
    label: 'Ver produção',
    description: 'Consultar o planejamento semanal, o quadro de produção e as tarefas de todos.',
  },
  'producao.planejar': {
    group: 'producao',
    label: 'Planejar e reprogramar produção',
    description:
      'Criar e publicar o planejamento semanal, definir responsáveis, prioridades, horários e dependências, bloquear e cancelar tarefas (gestor).',
    critical: true,
  },
  'producao.executar': {
    group: 'producao',
    label: 'Executar tarefas de produção',
    description:
      'Ver as próprias tarefas e a OS correspondente; iniciar, pausar, retomar, registrar andamento e concluir as próprias tarefas.',
  },
  'ajuda.solicitar': {
    group: 'producao',
    label: 'Pedir ajuda nas próprias tarefas',
    description:
      'Pedir apoio (normal ou urgente) nas próprias tarefas em andamento, consultar e cancelar os próprios pedidos.',
  },
  'ocorrencias.registrar': {
    group: 'producao',
    label: 'Registrar problemas nas próprias tarefas',
    description:
      'Abrir ocorrência (falta de material, problema técnico ou outro impedimento) nas próprias tarefas, com foto opcional, e acompanhá-la.',
  },
  'ocorrencias.ver': {
    group: 'producao',
    label: 'Ver central de atenção',
    description: 'Consultar a central de atenção, as ocorrências, seus impactos e o histórico.',
  },
  'ocorrencias.gerenciar': {
    group: 'producao',
    label: 'Delegar e encerrar ocorrências',
    description:
      'Atribuir a solução, confirmar ou recusar a resolução, reabrir e cancelar ocorrências (com motivo) e escolher o ajudante manualmente (gestor).',
    critical: true,
  },
  'qualidade.inspecionar': {
    group: 'qualidade',
    label: 'Inspecionar peças',
    description:
      'Ver as inspeções designadas, conferir o checklist, registrar fotos e observações, aprovar ou reprovar (com motivo). Quem executou o serviço não aprova sem autorização do gestor.',
  },
  'qualidade.gerenciar': {
    group: 'qualidade',
    label: 'Gerenciar qualidade e embalagem',
    description:
      'Consultar todas as inspeções, aprovar diretamente, designar substitutos, autorizar o executor, acompanhar correções, configurar checklists e localizações e distribuir embalagens (gestor).',
    critical: true,
  },
  'entregas.ver': {
    group: 'qualidade',
    label: 'Ver expedição e entregas',
    description: 'Consultar peças prontas, a agenda de entregas e as ocorrências logísticas.',
  },
  'entregas.gerenciar': {
    group: 'qualidade',
    label: 'Agendar e confirmar entregas',
    description:
      'Agendar, pré-agendar, confirmar, reprogramar e cancelar entregas, atribuir retiradas e entregas à logística e tratar ocorrências logísticas (exclusivo do gestor).',
    critical: true,
  },
  'logistica.executar': {
    group: 'qualidade',
    label: 'Executar retiradas e entregas atribuídas',
    description:
      'Ver apenas as próprias retiradas e entregas (endereço, contato, peças, data, horário, instruções) e registrar saída, chegada, entrega, instalação e ocorrências. Sem valores comerciais.',
  },
  'devolucoes.gerenciar': {
    group: 'qualidade',
    label: 'Devoluções e correção de recebimento',
    description:
      'Registrar e confirmar devoluções de peças ao cliente e corrigir recebimentos físicos com justificativa (gestor).',
    critical: true,
  },
  'presenca.registrar': {
    group: 'presenca',
    label: 'Registrar a própria presença',
    description:
      'Confirmar a própria chegada ("Cheguei") e encerrar o próprio expediente no tablet. Presença operacional, não é registro de ponto.',
  },
  'presenca.ver': {
    group: 'presenca',
    label: 'Ver presença da equipe',
    description:
      'Consultar chegadas, atrasos operacionais, ausências, disponibilidade e impactos na produção.',
  },
  'presenca.gerenciar': {
    group: 'presenca',
    label: 'Corrigir presença e registrar situações',
    description:
      'Confirmar ausências, registrar folgas, férias, ausências justificadas, atestados informados, trabalho externo e corrigir registros (com justificativa e histórico).',
    critical: true,
  },
  'financeiro.ver': {
    group: 'financeiro',
    label: 'Ver financeiro completo',
    description:
      'Consultar receitas, recebimentos, contas a pagar, custos por OS, margens, despesas, painel financeiro, indicadores e relatórios (gestor).',
    critical: true,
  },
  'financeiro.gerenciar': {
    group: 'financeiro',
    label: 'Registrar recebimentos, pagamentos e despesas',
    description:
      'Criar contas a receber e a pagar, registrar recebimentos e pagamentos (sem integração bancária), lançar despesas, custos logísticos, custos da equipe e valores de produção (gestor).',
    critical: true,
  },
  'financeiro.ajustes': {
    group: 'financeiro',
    label: 'Ajustes comerciais e de custos',
    description:
      'Conceder descontos, acréscimos e ajustes ao valor da OS, ajustar valores de produção e corrigir custos, sempre com motivo e histórico (gestor).',
    critical: true,
  },
  'financeiro.producao_propria': {
    group: 'financeiro',
    label: 'Ver os próprios valores de produção',
    description:
      'O tapeceiro vê apenas os próprios valores de produção e pagamentos, quando o gestor autorizar. Nunca vê valores de outras pessoas nem dos clientes.',
  },
  'auditoria.ver': {
    group: 'sistema',
    label: 'Ver auditoria',
    description: 'Consultar o registro de auditoria de ações críticas.',
  },
  'sincronizacao.diagnosticar': {
    group: 'sistema',
    label: 'Diagnóstico de sincronização',
    description: 'Enviar sinais de teste para verificar a sincronização entre dispositivos.',
  },
} as const satisfies Record<string, PermissionDefinition>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/**
 * Funções padrão criadas pelo seed. Funções marcadas como `system` não podem ser
 * excluídas e a função de gestor sempre mantém todas as permissões (evita que o
 * gestor perca acesso ao próprio sistema).
 */
export interface DefaultRoleDefinition {
  key: string;
  name: string;
  description: string;
  system: boolean;
  permissions: readonly Permission[];
}

export const GESTOR_ROLE_KEY = 'gestor';
/** André e Izaías (logística terceirizada): entram por PIN num dispositivo vinculado. */
export const LOGISTICS_ROLE_KEY = 'logistica_terceirizada';

export const DEFAULT_ROLES: readonly DefaultRoleDefinition[] = [
  {
    key: GESTOR_ROLE_KEY,
    name: 'Gestor',
    description:
      'Responsável por clientes, orçamentos, OS, compras, programação, decisões e entregas.',
    system: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'tapeceiro',
    name: 'Tapeceiro',
    description: 'Corte, costura e montagem. Cada sofá tem um tapeceiro principal.',
    system: true,
    permissions: [
      'producao.acessar',
      'producao.executar',
      'ocorrencias.registrar',
      'ajuda.solicitar',
      'presenca.registrar',
      'sincronizacao.diagnosticar',
    ],
  },
  {
    key: 'cabeceiras_qualidade',
    name: 'Cabeceiras, reparos e qualidade',
    description:
      'Fabricação de cabeceiras, reparos, preparação, instalações e inspeção final de qualidade.',
    system: true,
    permissions: [
      'producao.acessar',
      'producao.executar',
      'qualidade.inspecionar',
      'ocorrencias.registrar',
      'ajuda.solicitar',
      'presenca.registrar',
      'sincronizacao.diagnosticar',
    ],
  },
  {
    key: 'ajudante',
    name: 'Ajudante',
    description: 'Desmontagem, preparação e apoio à produção.',
    system: true,
    permissions: [
      'producao.acessar',
      'producao.executar',
      'ocorrencias.registrar',
      'presenca.registrar',
      'sincronizacao.diagnosticar',
    ],
  },
  {
    key: LOGISTICS_ROLE_KEY,
    name: 'Logística terceirizada',
    description:
      'Retiradas e entregas atribuídas: endereço, contato operacional, peças, data, horário e instruções. Sem valores comerciais.',
    system: true,
    permissions: ['producao.acessar', 'logistica.executar'],
  },
];

/** Resolve o conjunto efetivo de permissões a partir das funções e concessões diretas. */
export function resolvePermissions(
  rolePermissions: readonly (readonly string[])[],
  directGrants: readonly string[] = [],
): Permission[] {
  const set = new Set<Permission>();
  for (const list of rolePermissions) {
    for (const p of list) if (isPermission(p)) set.add(p);
  }
  for (const p of directGrants) if (isPermission(p)) set.add(p);
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}
