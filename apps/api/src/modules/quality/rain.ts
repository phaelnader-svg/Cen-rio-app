/**
 * Item 16 (lista de 53, 2026-11-27): aviso de chuva na véspera. Depois das 16h, se há entrega ou
 * retirada marcada para amanhã, o sistema olha a previsão da cidade (Open-Meteo, sem chave) e,
 * com chance de chuva alta, avisa quem cuida das entregas: "amanhã deve chover à tarde, 3
 * entregas marcadas". Um aviso por dia; previsão fora do ar não trava nada.
 */
import { RAIN_ALERT_PCT, type AddressSnapshot } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { requireCompanyId } from '../../core/tenant';
import type { ActorContext } from '../../core/types';
import { todaySaoPaulo } from '../billing/routes';
import { notifyUsersWith } from './common';

const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
/** A partir desta hora (São Paulo) o aviso da véspera sai. */
const FROM_HOUR = 16;

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const hourSp = (d: Date) =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
    }).format(d),
  ) % 24;

function addDay(iso: string) {
  const d = new Date(`${iso}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Período do dia com a maior chance de chuva (manhã, tarde ou noite). */
export function rainPeriod(hourly: number[]): { pct: number; when: string } | null {
  const parts: [string, number, number][] = [
    ['de manhã', 6, 12],
    ['à tarde', 12, 18],
    ['à noite', 18, 23],
  ];
  let best: { pct: number; when: string } | null = null;
  for (const [when, a, b] of parts) {
    const pct = Math.max(0, ...hourly.slice(a, b).filter((x) => Number.isFinite(x)));
    if (!best || pct > best.pct) best = { pct, when };
  }
  return best;
}

export async function rainRound(
  db: PrismaClient,
  fetchFn: Fetch = fetch as unknown as Fetch,
  now = new Date(),
): Promise<boolean> {
  if (hourSp(now) < FROM_HOUR) return false;
  const tomorrow = addDay(todaySaoPaulo(now));
  const cs = await db.companySettings.findUniqueOrThrow({
    where: { id: requireCompanyId() },
    select: {
      rainNoticeFor: true,
      weatherLat: true,
      weatherLon: true,
      weatherPlace: true,
      setupAnswers: true,
    },
  });
  if (cs.rainNoticeFor?.toISOString().slice(0, 10) === tomorrow) return false;
  const day = new Date(`${tomorrow}T00:00:00.000Z`);
  const [deliveries, pickups] = await Promise.all([
    db.delivery.findMany({
      where: { scheduledDate: day, status: { in: ['PROVISORIA', 'AGENDADA'] } },
      select: { addressSnapshot: true },
    }),
    db.pickupRequest.findMany({
      where: { scheduledDate: day, status: 'AGENDADA' },
      select: { addressSnapshot: true },
    }),
  ]);
  if (deliveries.length + pickups.length === 0) return false;

  // Cidade: a do começo guiado; sem ela, a que mais aparece nos endereços de amanhã.
  let lat = cs.weatherLat;
  let lon = cs.weatherLon;
  let place = cs.weatherPlace;
  const setupCity = (cs.setupAnswers as { city?: string } | null)?.city?.trim();
  const counts = new Map<string, number>();
  for (const j of [...deliveries, ...pickups]) {
    const c = (j.addressSnapshot as unknown as AddressSnapshot | null)?.city?.trim();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const city = setupCity || [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (lat === null || lon === null || (city && place !== city)) {
    if (!city) return false;
    const g = await fetchFn(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&country_code=BR`,
    );
    if (!g.ok) return false;
    const hit = ((await g.json()) as { results?: { latitude: number; longitude: number }[] })
      .results?.[0];
    if (!hit) return false;
    lat = hit.latitude;
    lon = hit.longitude;
    place = city;
    await db.companySettings.update({
      where: { id: requireCompanyId() },
      data: { weatherLat: lat, weatherLon: lon, weatherPlace: place },
    });
  }

  const f = await fetchFn(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability&timezone=America%2FSao_Paulo&start_date=${tomorrow}&end_date=${tomorrow}`,
  );
  if (!f.ok) return false;
  const hourly =
    ((await f.json()) as { hourly?: { precipitation_probability?: (number | null)[] } }).hourly
      ?.precipitation_probability ?? [];
  const period = rainPeriod(hourly.map((x) => (x === null ? NaN : x)));
  return db.$transaction(async (tx) => {
    // Marca o dia mesmo sem chuva: a previsão de amanhã é olhada uma vez só.
    await tx.companySettings.update({
      where: { id: requireCompanyId() },
      data: { rainNoticeFor: day },
    });
    if (!period || period.pct < RAIN_ALERT_PCT) return false;
    const jobs = [
      deliveries.length ? plural(deliveries.length, 'entrega', 'entregas') : null,
      pickups.length ? plural(pickups.length, 'retirada', 'retiradas') : null,
    ]
      .filter(Boolean)
      .join(' e ');
    const many = deliveries.length + pickups.length > 1;
    await notifyUsersWith(
      tx,
      SYSTEM,
      'entregas.gerenciar',
      'CHUVA_AMANHA',
      `chuva:${tomorrow}`,
      `Amanhã deve chover ${period.when} em ${place} (${period.pct}% de chance). ${jobs} ${many ? 'marcadas' : 'marcada'}: leve lona e plástico para proteger as peças, ou combine outro horário com o cliente.`,
    );
    return true;
  });
}
