/**
 * Multi-empresa — etapa 1: mapa de TODAS as tabelas do banco.
 *
 * Cada model do Prisma está classificado aqui. O teste `apps/api/test/multi-empresa-mapa.test.ts`
 * falha se um model novo aparecer sem classificação, ou se um item daqui deixar de existir —
 * assim nenhuma tabela entra no sistema sem alguém decidir de quem são os dados dela.
 *
 * Classes:
 * - `empresa`: dados de uma empresa. Recebe `company_id` (etapa 2) e a trava do banco
 *   (Row-Level Security, etapa 3): só a empresa de quem está logado enxerga as linhas.
 * - `acesso`: dados de login lidos ANTES de se saber a empresa (o cookie, o token, o tablet que
 *   pareia). Também recebem `company_id`, mas a busca pela credencial acontece numa conexão de
 *   autenticação; a partir dela a requisição passa a carregar a empresa.
 * - `sistema`: dados do sistema como um todo, sem dono (controles internos, apps cadastrados).
 *   Não recebem `company_id` e não podem guardar dados de clientes.
 * - `empresa-raiz`: a própria empresa (hoje `company_settings` com id fixo 1).
 */
export type TenancyClass = 'empresa' | 'acesso' | 'sistema' | 'empresa-raiz';

export interface TenancyEntry {
  class: TenancyClass;
  /**
   * Regras de unicidade que hoje valem para o sistema inteiro e passam a valer por empresa
   * (etapa 2). Ex.: o pedido nº 1 existe em cada empresa.
   */
  perCompanyUnique?: string[];
  /** Conteúdo inicial que cada empresa nova recebe ao ser criada (etapa 4). */
  seededPerCompany?: boolean;
  /**
   * Módulo removido do sistema em 2026-11-16 (Recebimentos, Medições, Compras, Recebimento de
   * materiais, Pedidos de ajuda). A tabela fica no banco sem uso pelas telas, mas guarda dados
   * reais da Cenário Estofados: recebe company_id e a trava como as demais.
   */
  legacy?: boolean;
  note?: string;
}

const E: TenancyEntry = { class: 'empresa' };
const numbered: TenancyEntry = { class: 'empresa', perCompanyUnique: ['number'] };
const L: TenancyEntry = { class: 'empresa', legacy: true };
const legacyNumbered: TenancyEntry = { ...numbered, legacy: true };

export const TENANCY: Record<string, TenancyEntry> = {
  // ── Empresa e acesso ────────────────────────────────────────────────────────────────
  CompanySettings: {
    class: 'empresa-raiz',
    note: 'Hoje uma linha fixa (id 1). Vira a tabela de empresas: uma linha por empresa.',
  },
  User: {
    class: 'acesso',
    note: 'E-mail continua único no sistema inteiro: um e-mail pertence a uma única empresa.',
  },
  Session: {
    class: 'acesso',
    note: 'Achada pelo hash do cookie; dela sai a empresa da requisição.',
  },
  Device: {
    class: 'acesso',
    perCompanyUnique: ['name'],
    note: 'Tablet pareado. O código de pareamento e a credencial seguem únicos no sistema.',
  },
  OAuthCode: { class: 'acesso' },
  OAuthGrant: { class: 'acesso' },
  OAuthAccessToken: { class: 'acesso' },
  OAuthClient: {
    class: 'sistema',
    note: 'Aplicativo cadastrado (vale para todas as empresas); a autorização é por usuário.',
  },
  AuthThrottle: {
    class: 'sistema',
    note: 'Contador de tentativas por IP/e-mail; sem dados de empresa.',
  },
  CompanyCounter: {
    class: 'empresa',
    note: 'Numeração de cada empresa (pedido nº, OS nº…), preenchida por gatilho no banco.',
  },
  EventConsumer: { class: 'sistema', note: 'Posição de cada processador de eventos.' },
  EmailToken: {
    class: 'acesso',
    note: 'Link de confirmar e-mail / redefinir senha: achado pelo hash antes de saber a empresa.',
  },
  OutboundEmail: {
    class: 'acesso',
    note: 'Fila de e-mails; enviada em segundo plano pelo banco do sistema.',
  },
  SubscriptionInvoice: {
    class: 'empresa',
    note: 'Cobrança da assinatura; o webhook do Asaas acha pelo id externo (único no sistema).',
  },

  // ── Pessoas, funções e permissões ────────────────────────────────────────────────────
  Employee: E,
  Role: { class: 'empresa', perCompanyUnique: ['key', 'name'], seededPerCompany: true },
  RolePermission: { class: 'empresa', seededPerCompany: true },
  UserRole: E,
  UserPermission: E,
  EmployeeSkill: E,
  ModuleSetting: {
    class: 'empresa',
    seededPerCompany: true,
    note: 'Módulos ligados/desligados; cada empresa escolhe os seus.',
  },
  CompanyHoliday: { class: 'empresa', perCompanyUnique: ['date'] },

  // ── Infraestrutura com dados da empresa ─────────────────────────────────────────────
  AuditLog: E,
  DomainEvent: {
    class: 'empresa',
    note: 'Fila de eventos: a sequência (seq) segue global; cada evento leva a empresa.',
  },
  IdempotencyKey: E,
  StoredFile: {
    class: 'empresa',
    note: 'Arquivos passam a ficar numa pasta por empresa (storageKey com o prefixo da empresa).',
  },
  Attachment: E,
  Notification: E,

  // ── Comercial ───────────────────────────────────────────────────────────────────────
  Customer: E,
  CustomerAddress: E,
  CommercialOrder: numbered,
  CommercialOrderItem: E,
  CommercialAdjustment: E,
  PickupRequest: numbered,
  PickupRequestItem: E,
  PickupEvent: E,
  Receipt: legacyNumbered,
  ReceiptLine: L,
  ReceiptCorrection: L,
  PieceReturn: numbered,
  PieceReturnLine: E,

  // ── Ordens de serviço e medição ─────────────────────────────────────────────────────
  ServiceOrder: numbered,
  ServiceOrderItem: E,
  ServiceOrderRevision: E,
  ServiceOrderItemOwnerChange: E,
  Measurement: legacyNumbered,
  MeasurementPiece: L,
  MeasurementRevision: L,
  ServiceModelMaterial: E,
  ServiceOrderMaterial: E,

  // ── Materiais, compras e estoque ────────────────────────────────────────────────────
  MaterialRequirement: L,
  MaterialRequest: L,
  MaterialRequestItem: L,
  Supplier: L,
  StockItem: { class: 'empresa', perCompanyUnique: ['number', 'specKey'], legacy: true },
  StockMovement: L,
  StockReservation: L,
  PurchaseOrder: legacyNumbered,
  PurchaseOrderItem: L,
  PurchaseAllocation: L,
  PurchaseOrderHistory: L,
  MaterialReceipt: legacyNumbered,
  MaterialReceiptLine: L,
  MaterialReceiptReversal: L,
  MaterialArrival: legacyNumbered,
  MaterialLeftover: L,
  MaterialLeftoverTransfer: L,
  InventoryCategory: E,
  InventoryItem: E,
  FabricRoll: E,
  InventoryAdjustment: E,

  // ── Produção ────────────────────────────────────────────────────────────────────────
  ProductionTemplate: { class: 'empresa', seededPerCompany: true },
  ProductionTemplateStep: { class: 'empresa', seededPerCompany: true },
  ProductionPlan: { class: 'empresa', perCompanyUnique: ['weekStart'] },
  ProductionPlanItem: E,
  ProductionPlanRevision: E,
  ProductionTask: numbered,
  TaskDependency: E,
  ProductionTaskEvent: E,
  ProductionTaskMaterial: E,
  PlanningAction: E,
  RescheduleProposal: numbered,
  HelpRequest: legacyNumbered,
  HelpRequestEvent: L,
  ProductionIssue: numbered,
  ProductionIssueEvent: E,
  LaborReview: numbered,

  // ── Presença ────────────────────────────────────────────────────────────────────────
  OperationalAttendance: E,
  AttendanceCorrection: E,
  AttendanceImpact: E,
  AttendanceLeave: numbered,
  AttendanceLeaveEvent: E,

  // ── Qualidade, embalagem, local das peças ──────────────────────────────────────────
  QualityTemplate: { class: 'empresa', seededPerCompany: true },
  QualityTemplateItem: { class: 'empresa', seededPerCompany: true },
  QualityInspection: numbered,
  QualityInspectionItem: E,
  QualityEvent: E,
  PackagingRecord: numbered,
  ItemLocation: { class: 'empresa', perCompanyUnique: ['key'], seededPerCompany: true },
  ItemLocationEvent: E,

  // ── Logística ───────────────────────────────────────────────────────────────────────
  Delivery: numbered,
  DeliveryItem: E,
  DeliveryEvent: E,
  LogisticsOccurrence: numbered,
  LogisticsOccurrenceEvent: E,
  LogisticsFreeTrip: E,
  LogisticsTripParticipant: E,

  // ── Orçamentos ──────────────────────────────────────────────────────────────────────
  QuoteCatalogItem: {
    class: 'empresa',
    seededPerCompany: true,
    note: 'Base de preços do orçamento; a migration de 2027-04-13 gravou a base inicial na empresa 1.',
  },
  QuoteSettings: {
    class: 'empresa',
    note: 'Uma linha por empresa (UNIQUE company_id). Hoje lida pelo id 1; etapa 3 lê pela empresa.',
  },
  Quote: numbered,

  // ── Financeiro ──────────────────────────────────────────────────────────────────────
  CustomerReceivable: numbered,
  CustomerPayment: E,
  CustomerPaymentReport: E,
  ServiceOrderCost: {
    class: 'empresa',
    note: 'sourceKey é montado com ids (UUID) e continua único no sistema.',
  },
  ProductionPayable: numbered,
  FinancialAdjustment: E,
  ProfessionalPayment: E,
  ProfessionalPaymentReversal: E,
  TeamMonthlyCost: E,
  LogisticsCost: numbered,
  LogisticsCostAllocation: E,
  LogisticsCostParticipant: E,
  LogisticsCostAdjustment: E,
  AccountPayable: numbered,
  PayablePayment: E,
  PayablePaymentReversal: E,
  RecurringExpense: E,
  OperationalExpense: numbered,
  FinancialEvent: E,
  ValueChangeRequest: numbered,
  WeeklyClosing: { class: 'empresa', perCompanyUnique: ['weekStart'] },
  WeeklyClosingEvent: E,
  WeeklyClosingConfirmation: numbered,
  ClosingPayment: numbered,
  ClosingPaymentPart: E,
  ClosingPaymentReversal: E,

  // ── Jogo (ambiente interativo), escritório e conexões (64c238f) ──────────────────────
  GameSpace: { class: 'empresa', perCompanyUnique: ['key'] },
  GameArea: E,
  GameStation: E,
  GameStationAssignee: E,
  GameStorageUnit: E,
  GameStorageSlot: E,
  GameSlotMaterial: E,
  GameLayoutRevision: E,
  AiAgent: E,
  AiAgentMessage: E,
  AiAgentProposal: E,
  MaterialPrice: E,
  // 2026-11-26 (começo guiado): convite do funcionário, explicações vistas e pedidos de ajuda.
  EmployeeInvite: {
    class: 'empresa',
    note: 'token_hash é aleatório e continua único no sistema (o link público acha a empresa por ele).',
  },
  UserSeenTip: E,
  ContactRequest: E,
  PaymentProof: E,
  ScreenView: E,
  HouseStandard: E,
  AgentAction: E,
  IntegrationConnection: {
    class: 'empresa',
    perCompanyUnique: ['providerKey'],
    note: 'Cada empresa conecta as próprias contas. Por enquanto só a empresa 1 conecta (as chaves do servidor são dela).',
  },
  IntegrationOAuthState: {
    class: 'empresa',
    note: 'state é aleatório e continua único no sistema.',
  },
  IntegrationWebhookEvent: {
    class: 'empresa',
    note: 'Webhooks dos provedores (chaves do servidor) são da empresa 1; (empresa, provedor, evento) é único.',
  },
  InboxConversation: { class: 'empresa', note: '(empresa, canal, conversa externa) é único.' },
  InboxMessage: E,
  MarketingPost: E,
  ContractTemplate: { class: 'empresa', note: '(empresa, chave, versão) é único.' },
  Contract: {
    class: 'empresa',
    perCompanyUnique: ['number'],
    note: 'providerEnvelopeId é do provedor e segue único.',
  },
  PaymentCharge: { class: 'empresa', note: 'Ids do provedor (cobrança/pagamento) seguem únicos.' },
  FiscalProfile: E,
  FiscalDocument: { class: 'empresa', note: 'providerRef é do provedor e segue único.' },
  BankAccount: E,
  BankTransaction: E,
  PaymentOrder: { class: 'empresa', note: 'providerRef é do provedor e segue único.' },
  CardSettlement: { class: 'empresa', note: '(empresa, provedor, id externo) é único.' },
  PurchaseQuote: E,
  AccountingDocument: E,
  CashSnapshot: E,
  CashEntry: E,
  CashGoal: E,
  CashGoalAchievement: E,
  CashWeekClosing: { class: 'empresa', perCompanyUnique: ['weekStart'] },
  // ── Melhorias da segunda rodada (2026-11-17) ───────────────────────────────────────
  FeedbackReport: {
    class: 'empresa',
    note: 'Sugestão ou problema enviado pela empresa; o dono da plataforma lê pela tela Empresas (banco do sistema).',
  },
  SystemNotice: {
    class: 'sistema',
    note: 'Aviso de manutenção do sistema inteiro (só texto e horário; sem dados de empresa).',
  },
  StatusSample: {
    class: 'sistema',
    note: 'Amostra da página de status (banco respondendo e tempo de resposta).',
  },
  // ── Painel da plataforma (2026-11-25) ─────────────────────────────────────────────
  PlatformAdmin: {
    class: 'sistema',
    note: 'Login do dono da plataforma; não pertence a nenhuma empresa.',
  },
  PlatformAdminSession: { class: 'sistema', note: 'Sessão do painel da plataforma.' },
  PlatformAdminReset: { class: 'sistema', note: '"Esqueci a senha" do painel da plataforma.' },
  PlatformPushSubscription: {
    class: 'sistema',
    note: 'Celulares do dono da plataforma que recebem os avisos do painel.',
  },
  PlatformAuditLog: {
    class: 'sistema',
    note: 'O que o dono da plataforma fez no painel (resumo, sem dados de clientes).',
  },
  PlatformSettings: {
    class: 'sistema',
    note: 'Preços, teste, bloqueio e PIX do dono da plataforma (uma linha).',
  },
  // ── Despesas, prazos e alertas (2026-11-18) ────────────────────────────────────────
  ExpenseCategory: {
    class: 'empresa',
    perCompanyUnique: ['name'],
    note: 'Categoria de despesa criada pela empresa; cada empresa tem as suas.',
  },
  // ── Retrabalhos e receitas avulsas (2026-11-18) ────────────────────────────────────
  Rework: numbered,
  ManualRevenue: {
    class: 'empresa',
    note: 'Dinheiro que entrou fora das cobranças de pedido (aba Receitas do financeiro).',
  },
  // ── LGPD (2026-11-25) ───────────────────────────────────────────────────────────────
  PrivacyRequest: {
    class: 'empresa',
    note: 'Pedido sobre dados pessoais. O da página pública fica na empresa da plataforma; o dono da plataforma lê todos pela tela Empresas (banco do sistema).',
  },
  // ── App instalado: avisos no celular e no tablet (2026-11-25) ──────────────────────
  PushKey: {
    class: 'sistema',
    note: 'Chaves dos avisos (VAPID), uma linha só, iguais para todas as empresas.',
  },
  PushSubscription: {
    class: 'empresa',
    note: 'Aparelho da empresa que aceitou avisos; o endereço do aviso (endpoint) é único no sistema.',
  },
};

export function tenancyOf(model: string): TenancyEntry | undefined {
  return TENANCY[model];
}
