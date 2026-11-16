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
  note?: string;
}

const E: TenancyEntry = { class: 'empresa' };
const numbered: TenancyEntry = { class: 'empresa', perCompanyUnique: ['number'] };

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
  EventConsumer: { class: 'sistema', note: 'Posição de cada processador de eventos.' },

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
  Receipt: numbered,
  ReceiptLine: E,
  ReceiptCorrection: E,
  PieceReturn: numbered,
  PieceReturnLine: E,

  // ── Ordens de serviço e medição ─────────────────────────────────────────────────────
  ServiceOrder: numbered,
  ServiceOrderItem: E,
  ServiceOrderRevision: E,
  ServiceOrderItemOwnerChange: E,
  Measurement: numbered,
  MeasurementPiece: E,
  MeasurementRevision: E,
  ServiceModelMaterial: E,
  ServiceOrderMaterial: E,

  // ── Materiais, compras e estoque ────────────────────────────────────────────────────
  MaterialRequirement: E,
  MaterialRequest: E,
  MaterialRequestItem: E,
  Supplier: E,
  StockItem: { class: 'empresa', perCompanyUnique: ['number', 'specKey'] },
  StockMovement: E,
  StockReservation: E,
  PurchaseOrder: numbered,
  PurchaseOrderItem: E,
  PurchaseAllocation: E,
  PurchaseOrderHistory: E,
  MaterialReceipt: numbered,
  MaterialReceiptLine: E,
  MaterialReceiptReversal: E,
  MaterialArrival: numbered,
  MaterialLeftover: E,
  MaterialLeftoverTransfer: E,
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
  HelpRequest: numbered,
  HelpRequestEvent: E,
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
};

export function tenancyOf(model: string): TenancyEntry | undefined {
  return TENANCY[model];
}
