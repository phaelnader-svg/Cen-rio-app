import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { EVENT_TYPES } from '@cenario/shared';
import { createPrismaClient, ensureAppDbRole, type PrismaClient } from '@cenario/db';
import {
  createCompanyPrisma,
  createSystemPrisma,
  forEachCompany,
  tenantStorage,
  type TenantStore,
} from './core/tenant';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Env } from './config/env';
import { buildClientIpConfig } from './core/client-ip';
import { registerRateLimits } from './core/rate-limit';
import { appendEvent } from './core/events/append';
import { EventFeed } from './core/events/feed';
import { EventProcessor } from './core/events/processor';
import { runMaintenance } from './core/maintenance';
import { RealtimeHub } from './core/realtime/hub';
import { LocalFileStorage } from './core/storage/storage';
import type { AppContext } from './core/types';
import { createTokenHasher } from './lib/crypto';
import { LOG_REDACT_PATHS } from './lib/log-redaction';
import { auditRoutes } from './modules/audit/routes';
import { publicRoutes, recordStatusSample } from './modules/public/routes';
import { improvementRoutes } from './modules/improvements/routes';
import { twoFactorRoutes } from './modules/account/two-factor';
import { companyExportRoutes } from './modules/exports/company-export';
import { importRoutes } from './modules/customers/import';
import { managementRoutes } from './modules/management/routes';
import { refreshOperationalAlerts, todayRoutes } from './modules/management/today';
import { attachmentRoutes } from './modules/attachments/routes';
import { authRoutes } from './modules/auth/routes';
import { customerRoutes } from './modules/customers/routes';
import { exportRoutes } from './modules/exports/routes';
import { releaseDueTasks } from './modules/production/common';
import { autoReceiveDuePickups } from './modules/pickups/arrival';
import { productionPlanRoutes } from './modules/production/plans';
import { productionProductivityRoutes } from './modules/production/productivity';
import { productionTaskRoutes } from './modules/production/tasks';
import { productionQueueRoutes } from './modules/production/queue';
import { productionDistributionRoutes } from './modules/production/distribution';
import { preplanningRoutes } from './modules/production/pre-planning';
import { notificationRoutes } from './modules/notifications/routes';
import { notificationSummaryRoutes } from './modules/notifications/daily-summary';
import { detectAbsences, detectOpenShifts } from './modules/attendance/absence';
import { attendanceRoutes } from './modules/attendance/routes';
import { helpRoutes } from './modules/help/routes';
import { issueRoutes } from './modules/issues/routes';
import { qualityRoutes } from './modules/quality/routes';
import { logisticsRouteRoutes } from './modules/quality/route';
import { financeRoutes } from './modules/finance/routes';
import { laborReviewRoutes } from './modules/finance/labor-review';
import { tripCostRoutes } from './modules/finance/trip-costs';
import { closingRoutes } from './modules/finance/closing';
import { myEarningsRoutes } from './modules/finance/my-earnings';
import { confirmationRoutes } from './modules/finance/confirmations';
import { valueRequestRoutes } from './modules/finance/value-requests';
import { billingRoutes } from './modules/finance/billing';
import { processIssueRisks } from './modules/issues/service';
import { deviceCustomerPrivacy } from './core/device-privacy';
import { testClockRoutes } from './modules/testing/routes';
import { orderRoutes } from './modules/orders/routes';
import { pickupRoutes } from './modules/pickups/routes';
import { serviceRoutes } from './modules/services/routes';
import { serviceOrderRoutes } from './modules/service-orders/routes';
import { osMaterialRoutes } from './modules/os-materials/routes';
import { serviceModelRoutes } from './modules/service-models/routes';
import { workshopMapRoutes } from './modules/workshop-map/routes';
import { gameSpaceRoutes } from './modules/game/spaces';
import { gameSnapshotRoutes } from './modules/game/snapshot';
import { gameAgentRoutes } from './modules/game/agents';
import { gameCommandRoutes } from './modules/game/command';
import { gameSupplierRoutes } from './modules/game/suppliers';
import { connectionRoutes } from './modules/integrations/connections';
import { inboxRoutes } from './modules/integrations/inbox';
import { marketingRoutes } from './modules/integrations/marketing';
import { officeWebhookRoutes } from './modules/integrations/office-webhooks';
import { chargeRoutes } from './modules/office/charges';
import { contractRoutes } from './modules/office/contracts';
import './modules/office/chat';
import { fichaRoutes } from './modules/office/ficha';
import { fiscalRoutes } from './modules/office/fiscal';
import { bankRoutes } from './modules/office/bank';
import { cashRoutes } from './modules/office/cash';
import { closingRoutes as officeClosingRoutes } from './modules/office/closing';
import { directDeliveryRoutes } from './modules/quality/direct-delivery';
import { inventoryRoutes } from './modules/inventory/routes';
import { quoteRoutes } from './modules/quotes/routes';
import { reworkRoutes } from './modules/reworks/routes';
import { serviceOrderSheetRoutes } from './modules/service-orders/sheet';
import { companyRoutes } from './modules/company/routes';
import { platformRoutes } from './modules/platform/routes';
import { billingRoutesPlatform } from './modules/billing/routes';
import { accountRoutes } from './modules/account/routes';
import { EmailSender } from './core/mailer';
import { turnstileVerifier } from './core/captcha';
import { setBillingEnvironment } from './core/billing';
import { deviceRoutes } from './modules/devices/routes';
import { employeeRoutes } from './modules/employees/routes';
import { fileRoutes } from './modules/files/routes';
import { healthRoutes } from './modules/health/routes';
import { realtimeRoutes } from './modules/realtime/routes';
import { roleRoutes } from './modules/roles/routes';
import { sessionRoutes } from './modules/sessions/routes';
import { syncRoutes } from './modules/sync/routes';
import { tabletRoutes } from './modules/tablet/routes';
import { oauthRoutes } from './modules/apps/oauth';
import { authPlugin } from './plugins/auth';
import { errorHandlerPlugin } from './plugins/error-handler';
import { idempotencyPlugin } from './plugins/idempotency';

export interface BuildOptions {
  env: Env;
  prisma?: PrismaClient;
  /** Logger desativado em testes, salvo quando LOG_LEVEL é informado. */
  logger?: boolean;
  feedPollIntervalMs?: number;
}

export interface App {
  app: FastifyInstance;
  ctx: AppContext;
  /** Inicia fluxos de eventos e tarefas em segundo plano. */
  startBackground(): Promise<void>;
  close(): Promise<void>;
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export async function buildApp(options: BuildOptions): Promise<App> {
  const { env } = options;
  const isDev = env.APP_ENV === 'development';
  const clientIp = buildClientIpConfig(env);
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: { paths: LOG_REDACT_PATHS, censor: '[removido]' },
            ...(isDev && process.stdout.isTTY
              ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
              : {}),
          },
    // Só o proxy declarado em TRUST_PROXY, e só como salto imediato (core/client-ip.ts).
    trustProxy: clientIp.trust,
    bodyLimit: 256 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  const base = options.prisma ?? createPrismaClient({ url: env.DATABASE_URL });
  // Papel cenario_app e privilégios (refeitos após restaurar um backup sem GRANTs).
  await ensureAppDbRole(base);
  // Multi-empresa (etapa 3): todo acesso ao banco passa por um destes dois clientes. O da
  // empresa só enxerga a empresa da requisição; o do sistema atravessa empresas e é usado só onde
  // isso é necessário (core/tenant.ts).
  const prisma = createCompanyPrisma(base);
  const system = createSystemPrisma(base);
  const feed = new EventFeed(system, env.DATABASE_URL, app.log, options.feedPollIntervalMs);
  const hub = new RealtimeHub(system, feed, app.log);
  const processor = new EventProcessor(system, app.log);
  const secure = env.COOKIE_SECURE;
  const ctx: AppContext = {
    env,
    prisma,
    system,
    hashToken: createTokenHasher(env.TOKEN_HASH_SECRET),
    hub,
    storage: new LocalFileStorage(env.STORAGE_DIR),
    processor,
    // Prefixo __Host- (exige HTTPS, Path=/ e ausência de Domain) quando seguro.
    cookies: {
      session: secure ? '__Host-cen_sid' : 'cen_sid',
      device: secure ? '__Host-cen_dev' : 'cen_dev',
    },
    clientIp,
    mailer: new EmailSender(system, env, app.log),
    captcha: turnstileVerifier(env),
    fetch: (...args) => globalThis.fetch(...args),
  };
  app.decorate('ctx', ctx);
  setBillingEnvironment(env, () => ctx.mailer.configured);
  // Cada requisição ganha o seu "de qual empresa" (preenchido pela autenticação).
  app.decorateRequest('tenant', null);
  app.addHook('onRequest', (request, _reply, done) => {
    const store: TenantStore = { companyId: null };
    request.tenant = store;
    tenantStorage.run(store, done);
  });
  for (const warning of clientIp.warnings) app.log.warn({ alerta: 'ip-do-cliente' }, warning);

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header('x-request-id', request.id);
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    return payload;
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: env.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  await registerRateLimits(app, {
    ipPerMinute: env.RATE_LIMIT_IP_PER_MIN,
    unknownIpPerMinute: env.RATE_LIMIT_UNKNOWN_IP_PER_MIN,
    sessionPerMinute: env.RATE_LIMIT_SESSION_PER_MIN,
    anonymousPerMinute: env.RATE_LIMIT_ANON_PER_MIN,
    unknownAnonymousPerMinute: env.RATE_LIMIT_UNKNOWN_ANON_PER_MIN,
  });
  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 },
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  // Reformulação, Fase 0: privacidade do cliente nos tablets vale para todas as rotas (raiz).
  deviceCustomerPrivacy(app);

  await app.register(healthRoutes);
  await app.register(publicRoutes);
  await app.register(improvementRoutes);
  await app.register(twoFactorRoutes);
  await app.register(companyExportRoutes);
  await app.register(importRoutes);
  await app.register(authRoutes);
  await app.register(tabletRoutes);
  await app.register(employeeRoutes);
  await app.register(roleRoutes);
  await app.register(deviceRoutes);
  await app.register(sessionRoutes);
  await app.register(companyRoutes);
  await app.register(platformRoutes);
  await app.register(billingRoutesPlatform);
  await app.register(accountRoutes);
  await app.register(auditRoutes);
  await app.register(managementRoutes);
  await app.register(todayRoutes);
  await app.register(syncRoutes);
  await app.register(fileRoutes);
  await app.register(realtimeRoutes);
  // Fase 2 — fluxo comercial → oficina (API versionada /api/v1)
  await app.register(customerRoutes);
  await app.register(exportRoutes);
  await app.register(orderRoutes);
  await app.register(pickupRoutes);
  await app.register(serviceRoutes);
  await app.register(serviceOrderRoutes);
  await app.register(osMaterialRoutes);
  await app.register(serviceModelRoutes);
  await app.register(workshopMapRoutes);
  await app.register(gameSpaceRoutes);
  await app.register(gameSnapshotRoutes);
  await app.register(gameAgentRoutes);
  await app.register(gameCommandRoutes);
  await app.register(gameSupplierRoutes);
  await app.register(connectionRoutes);
  await app.register(inboxRoutes);
  await app.register(marketingRoutes);
  await app.register(officeWebhookRoutes);
  await app.register(contractRoutes);
  await app.register(chargeRoutes);
  await app.register(fichaRoutes);
  await app.register(fiscalRoutes);
  await app.register(bankRoutes);
  await app.register(cashRoutes);
  await app.register(officeClosingRoutes);
  await app.register(directDeliveryRoutes);
  await app.register(inventoryRoutes);
  await app.register(quoteRoutes);
  await app.register(reworkRoutes);
  await app.register(serviceOrderSheetRoutes);
  await app.register(attachmentRoutes);
  // Fase 3 — medições e solicitações de materiais
  await app.register(productionPlanRoutes);
  await app.register(productionProductivityRoutes);
  await app.register(productionTaskRoutes);
  await app.register(productionQueueRoutes);
  await app.register(productionDistributionRoutes);
  await app.register(preplanningRoutes);
  await app.register(notificationRoutes);
  await app.register(notificationSummaryRoutes);
  await app.register(attendanceRoutes);
  await app.register(helpRoutes);
  await app.register(issueRoutes);
  await app.register(qualityRoutes);
  await app.register(logisticsRouteRoutes);
  await app.register(financeRoutes);
  await app.register(laborReviewRoutes);
  await app.register(tripCostRoutes);
  await app.register(closingRoutes);
  await app.register(myEarningsRoutes);
  await app.register(confirmationRoutes);
  await app.register(valueRequestRoutes);
  await app.register(billingRoutes);
  // Autorização delegada de aplicativos (OAuth 2.0 + PKCE), ex.: Firma Viva.
  await app.register(oauthRoutes);
  // Relógio de teste: só existe com ENABLE_TEST_CLOCK (validado para APP_ENV=test).
  if (env.ENABLE_TEST_CLOCK && env.APP_ENV === 'test') await app.register(testClockRoutes);

  // Presença dos tablets: transições online/offline viram eventos persistentes.
  hub.onPresence((deviceId, online) => {
    void prisma
      .$transaction(async (tx) => {
        const device = await tx.device.findUnique({ where: { id: deviceId } });
        if (!device) return;
        await tx.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
        await appendEvent(
          tx,
          { userId: null, sessionId: null, ip: null, requestId: null },
          {
            type: EVENT_TYPES.DEVICE_CONNECTION_CHANGED,
            aggregateType: 'device',
            aggregateId: deviceId,
            payload: { id: deviceId, name: device.name, online },
            audience: 'permission:dispositivos.ver',
          },
        );
      })
      .catch((err: unknown) => app.log.warn({ err }, 'Falha ao registrar presença do dispositivo'));
  });

  let maintenanceTimer: NodeJS.Timeout | null = null;
  let alertTimer: NodeJS.Timeout | null = null;
  let releaseTimer: NodeJS.Timeout | null = null;
  let arrivalTimer: NodeJS.Timeout | null = null;
  let absenceTimer: NodeJS.Timeout | null = null;
  let issueTimer: NodeJS.Timeout | null = null;
  let emailTimer: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let started = false;

  return {
    app,
    ctx,
    async startBackground() {
      if (started) return;
      started = true;
      await feed.start();
      hub.start();
      if (!env.DISABLE_BACKGROUND_JOBS) {
        feed.onEvents(() => void processor.kick());
        processor.start();
        maintenanceTimer = setInterval(
          () =>
            void runMaintenance(system, app.log).catch((err: unknown) =>
              app.log.warn({ err }, 'Falha na manutenção periódica'),
            ),
          15 * 60_000,
        );
        maintenanceTimer.unref();
        // Reformulação Fase 4: alertas internos (prazo, peça pronta, material). Só o sininho.
        alertTimer = setInterval(
          () =>
            void forEachCompany(system, () => refreshOperationalAlerts(prisma)).catch(
              (err: unknown) =>
                app.log.warn({ err }, 'Falha ao recalcular os alertas operacionais'),
            ),
          5 * 60_000,
        );
        alertTimer.unref();
        // Fase 5: libera as tarefas cujo horário programado chegou (idempotente).
        releaseTimer = setInterval(
          () =>
            void forEachCompany(system, () => releaseDueTasks(prisma)).catch((err: unknown) =>
              app.log.warn({ err }, 'Falha ao liberar tarefas programadas'),
            ),
          30_000,
        );
        releaseTimer.unref();
        // Fluxo da OS (2026-11-18): peça da retirada "na tapeçaria" 1 hora após o horário.
        arrivalTimer = setInterval(
          () =>
            void forEachCompany(system, () => autoReceiveDuePickups(prisma)).catch((err: unknown) =>
              app.log.warn({ err }, 'Falha ao marcar as retiradas chegadas'),
            ),
          5 * 60_000,
        );
        arrivalTimer.unref();
        // Fase 7: ausência presumida após o limite configurado (idempotente).
        absenceTimer = setInterval(
          () =>
            void forEachCompany(system, () =>
              detectAbsences(prisma)
                // Simplificação Fase 7: expediente esquecido vira alerta (nunca saída inventada).
                .then(() => detectOpenShifts(prisma)),
            ).catch((err: unknown) =>
              app.log.warn({ err }, 'Falha ao verificar presença da equipe'),
            ),
          60_000,
        );
        absenceTimer.unref();
        // Fase 9: prazos de resolução das ocorrências e propostas sem sentido.
        issueTimer = setInterval(
          () =>
            void forEachCompany(system, () => processIssueRisks(prisma)).catch((err: unknown) =>
              app.log.warn({ err }, 'Falha ao processar os prazos das ocorrências'),
            ),
          30_000,
        );
        issueTimer.unref();
        // Fila de e-mails (confirmação, nova senha, assinatura): novas tentativas.
        emailTimer = setInterval(() => ctx.mailer.kick(), 60_000);
        emailTimer.unref();
        ctx.mailer.kick();
        // Melhoria 100: amostra da página de status a cada 5 minutos (falta de amostra = fora do ar).
        const sample = () =>
          void recordStatusSample(system).catch((err: unknown) =>
            app.log.warn({ err }, 'Falha ao gravar a amostra da página de status'),
          );
        statusTimer = setInterval(sample, 5 * 60_000);
        statusTimer.unref();
        sample();
      }
    },
    async close() {
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      if (alertTimer) clearInterval(alertTimer);
      if (releaseTimer) clearInterval(releaseTimer);
      if (arrivalTimer) clearInterval(arrivalTimer);
      if (absenceTimer) clearInterval(absenceTimer);
      if (issueTimer) clearInterval(issueTimer);
      if (emailTimer) clearInterval(emailTimer);
      if (statusTimer) clearInterval(statusTimer);
      processor.stop();
      hub.stop();
      await feed.stop();
      await app.close();
      if (!options.prisma) await base.$disconnect();
    },
  };
}
