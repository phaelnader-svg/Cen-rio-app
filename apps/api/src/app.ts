import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { EVENT_TYPES } from '@cenario/shared';
import { createPrismaClient, type PrismaClient } from '@cenario/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type { Env } from './config/env';
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
import { attachmentRoutes } from './modules/attachments/routes';
import { authRoutes } from './modules/auth/routes';
import { customerRoutes } from './modules/customers/routes';
import { materialRoutes } from './modules/materials/routes';
import { measurementRoutes } from './modules/measurements/routes';
import { releaseDueTasks } from './modules/production/common';
import { productionPlanRoutes } from './modules/production/plans';
import { productionTaskRoutes } from './modules/production/tasks';
import { productionQueueRoutes } from './modules/production/queue';
import { productionDistributionRoutes } from './modules/production/distribution';
import { notificationRoutes } from './modules/notifications/routes';
import { detectAbsences } from './modules/attendance/absence';
import { attendanceRoutes } from './modules/attendance/routes';
import { helpRoutes } from './modules/help/routes';
import { issueRoutes } from './modules/issues/routes';
import { qualityRoutes } from './modules/quality/routes';
import { financeRoutes } from './modules/finance/routes';
import { processIssueRisks } from './modules/issues/service';
import { processHelpQueue } from './modules/help/queue';
import { testClockRoutes } from './modules/testing/routes';
import { leftoverRoutes } from './modules/purchasing/leftovers';
import { purchaseOrderRoutes } from './modules/purchasing/purchase-orders';
import { materialReceiptRoutes } from './modules/purchasing/receipts';
import { stockRoutes } from './modules/purchasing/stock';
import { supplierRoutes } from './modules/purchasing/suppliers';
import { orderRoutes } from './modules/orders/routes';
import { pickupRoutes } from './modules/pickups/routes';
import { receiptRoutes } from './modules/receipts/routes';
import { serviceOrderRoutes } from './modules/service-orders/routes';
import { companyRoutes } from './modules/company/routes';
import { deviceRoutes } from './modules/devices/routes';
import { employeeRoutes } from './modules/employees/routes';
import { fileRoutes } from './modules/files/routes';
import { healthRoutes } from './modules/health/routes';
import { realtimeRoutes } from './modules/realtime/routes';
import { roleRoutes } from './modules/roles/routes';
import { sessionRoutes } from './modules/sessions/routes';
import { syncRoutes } from './modules/sync/routes';
import { tabletRoutes } from './modules/tablet/routes';
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
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  const prisma = options.prisma ?? createPrismaClient({ url: env.DATABASE_URL });
  const feed = new EventFeed(prisma, env.DATABASE_URL, app.log, options.feedPollIntervalMs);
  const hub = new RealtimeHub(prisma, feed, app.log);
  const processor = new EventProcessor(prisma, app.log);
  const secure = env.COOKIE_SECURE;
  const ctx: AppContext = {
    env,
    prisma,
    hashToken: createTokenHasher(env.TOKEN_HASH_SECRET),
    hub,
    storage: new LocalFileStorage(env.STORAGE_DIR),
    processor,
    // Prefixo __Host- (exige HTTPS, Path=/ e ausência de Domain) quando seguro.
    cookies: {
      session: secure ? '__Host-cen_sid' : 'cen_sid',
      device: secure ? '__Host-cen_dev' : 'cen_dev',
    },
  };
  app.decorate('ctx', ctx);

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
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // O WebSocket tem controle próprio; limitar o upgrade atrapalharia reconexões.
    allowList: (request) => request.url === '/api/realtime',
    // Atrás do proxy do Next todos os navegadores chegam do mesmo IP: o limite é por sessão
    // (cookie de sessão ou de dispositivo), com o IP apenas como alternativa.
    keyGenerator: (request) => {
      const c = request.cookies ?? {};
      const token = c[ctx.cookies.session] ?? c[ctx.cookies.device];
      return token
        ? `s:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
        : request.ip;
    },
  });
  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 },
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(tabletRoutes);
  await app.register(employeeRoutes);
  await app.register(roleRoutes);
  await app.register(deviceRoutes);
  await app.register(sessionRoutes);
  await app.register(companyRoutes);
  await app.register(auditRoutes);
  await app.register(syncRoutes);
  await app.register(fileRoutes);
  await app.register(realtimeRoutes);
  // Fase 2 — fluxo comercial → oficina (API versionada /api/v1)
  await app.register(customerRoutes);
  await app.register(orderRoutes);
  await app.register(pickupRoutes);
  await app.register(receiptRoutes);
  await app.register(serviceOrderRoutes);
  await app.register(attachmentRoutes);
  // Fase 3 — medições e solicitações de materiais
  await app.register(measurementRoutes);
  await app.register(materialRoutes);
  await app.register(supplierRoutes);
  await app.register(purchaseOrderRoutes);
  await app.register(materialReceiptRoutes);
  await app.register(stockRoutes);
  await app.register(leftoverRoutes);
  await app.register(productionPlanRoutes);
  await app.register(productionTaskRoutes);
  await app.register(productionQueueRoutes);
  await app.register(productionDistributionRoutes);
  await app.register(notificationRoutes);
  await app.register(attendanceRoutes);
  await app.register(helpRoutes);
  await app.register(issueRoutes);
  await app.register(qualityRoutes);
  await app.register(financeRoutes);
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
  let releaseTimer: NodeJS.Timeout | null = null;
  let absenceTimer: NodeJS.Timeout | null = null;
  let helpTimer: NodeJS.Timeout | null = null;
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
            void runMaintenance(prisma, app.log).catch((err: unknown) =>
              app.log.warn({ err }, 'Falha na manutenção periódica'),
            ),
          15 * 60_000,
        );
        maintenanceTimer.unref();
        // Fase 5: libera as tarefas cujo horário programado chegou (idempotente).
        releaseTimer = setInterval(
          () =>
            void releaseDueTasks(prisma).catch((err: unknown) =>
              app.log.warn({ err }, 'Falha ao liberar tarefas programadas'),
            ),
          30_000,
        );
        releaseTimer.unref();
        // Fase 7: ausência presumida após o limite configurado (idempotente).
        absenceTimer = setInterval(
          () =>
            void detectAbsences(prisma).catch((err: unknown) =>
              app.log.warn({ err }, 'Falha ao verificar presença da equipe'),
            ),
          60_000,
        );
        absenceTimer.unref();
        // Fase 8: fila de ajuda (atribuição quando alguém fica livre e alerta de atraso).
        helpTimer = setInterval(
          () =>
            void processHelpQueue(prisma)
              // Fase 9: prazos de resolução das ocorrências e propostas sem sentido.
              .then(() => processIssueRisks(prisma))
              .catch((err: unknown) => app.log.warn({ err }, 'Falha ao processar a fila de ajuda')),
          30_000,
        );
        helpTimer.unref();
      }
    },
    async close() {
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      if (releaseTimer) clearInterval(releaseTimer);
      if (absenceTimer) clearInterval(absenceTimer);
      if (helpTimer) clearInterval(helpTimer);
      processor.stop();
      hub.stop();
      await feed.stop();
      await app.close();
      if (!options.prisma) await prisma.$disconnect();
    },
  };
}
