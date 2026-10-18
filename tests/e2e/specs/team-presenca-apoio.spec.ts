import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * Simplificação Fase 7 — presença simplificada no painel e no tablet (dados fictícios). Relógio
 * de teste num dia próprio (hoje + 77, fora das janelas das demais specs): expediente esquecido resolvido pelo gestor sem horário
 * inventado, calendário de feriados, férias por intervalo e o tablet sem avaliação de pontualidade.
 */
const TZ = 'America/Sao_Paulo';
const origin = `http://localhost:${E2E.webPort}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DAY = addDays(today(), 77);
const atLocal = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-03:00`).toISOString();
const br = (iso: string) => iso.split('-').reverse().slice(0, 2).join('/');
const evidence = (page: Page, name: string) =>
  process.env.E2E_EVIDENCE
    ? page.screenshot({
        path: `../../docs/evidencias/simplificacao-fase-7/${name}.png`,
        fullPage: true,
      })
    : Promise.resolve();

async function call(page: Page, method: 'POST' | 'PUT' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test.describe.serial('Simplificação Fase 7 — presença e apoio', () => {
  test('expediente esquecido, feriado, férias por intervalo e tablet sem pontualidade', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const setClock = (day: string | null, hhmm = '08:00') =>
      call(page, 'POST', '/api/test/clock', { now: day ? atLocal(day, hhmm) : null });
    try {
      const c = await call(page, 'GET', '/api/company/settings');
      await call(page, 'PUT', '/api/company/settings', {
        ...c,
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        arrivalWindowStart: '07:00',
        workdayStart: '08:30',
        arrivalAlertAt: '09:30',
        workdayEnd: '18:00',
        lateAlertMinutes: 15,
      });
      await setPin(page, 'Thiago', '418263');
      const thiago = await openTablet(
        browser,
        await registerDevice(page, 'Tablet Thiago (F7 simplificada)', 'Thiago'),
        '418263',
      );
      const tt = thiago.page;

      // 1. Véspera: Thiago confirma a chegada e esquece de encerrar.
      await setClock(addDays(DAY, -1), '08:30');
      await tt.reload();
      await tt.getByTestId('arrive-button').click();
      await expect(tt.getByTestId('presence-status')).toContainText('Presente desde');

      // 2. No dia seguinte o gestor vê o expediente sem saída e resolve (horário informado).
      await setClock(DAY, '08:00');
      await call(page, 'POST', '/api/test/attendance/check', {});
      await page.goto('/painel/presenca');
      const open = page.getByTestId('open-shift-Thiago');
      await expect(open).toContainText('sem encerramento');
      await expect(open).toContainText('08:30');
      await evidence(page, '01-expediente-sem-saida');
      await open.getByRole('button', { name: 'Resolver' }).click();
      const dlg = page.getByRole('dialog');
      await expect(dlg.getByLabel('O que registrar')).toHaveValue('REGISTRAR_SAIDA');
      await dlg.getByLabel('Horário de saída').fill('17:30');
      await dlg.getByLabel('Justificativa').fill('Saiu às 17h30 (confirmado com ele)');
      await dlg.getByRole('button', { name: 'Salvar' }).click();
      await expect(dlg).toHaveCount(0);
      await expect(page.getByTestId('open-shifts')).toHaveCount(0);

      // 3. Calendário: amanhã é feriado (sem expediente normal).
      await page.getByTestId('holiday-new').click();
      const hd = page.getByRole('dialog');
      await hd.getByLabel('Data').fill(addDays(DAY, 1));
      await hd.getByLabel('Nome').fill('Feriado municipal (E2E)');
      await hd.getByTestId('holiday-save').click();
      await expect(page.getByTestId(`holiday-${addDays(DAY, 1)}`)).toContainText(
        'Feriado municipal (E2E)',
      );

      // 4. Férias por intervalo do Thiago (sem lançar dia a dia).
      await page.getByTestId('leave-new').click();
      const ld = page.getByRole('dialog');
      await ld.getByLabel('Funcionário').selectOption({ label: 'Thiago' });
      await ld.getByLabel('Tipo').selectOption('FERIAS');
      await ld.getByLabel('Data inicial').fill(addDays(DAY, 2));
      await ld.getByLabel('Data final').fill(addDays(DAY, 6));
      await ld.getByLabel('Motivo').fill('Férias combinadas (E2E)');
      await ld.getByTestId('leave-save').click();
      const leave = page
        .getByTestId('leaves')
        .locator('li', { hasText: 'Férias combinadas (E2E)' });
      await expect(leave).toContainText(`${br(addDays(DAY, 2))}`);
      await expect(leave).toContainText('5 dias');
      await evidence(page, '02-calendario-e-ferias');

      // 5. Hoje Thiago chega atrasado: o tablet não mostra atraso; o gestor vê.
      await setClock(DAY, '08:50');
      await tt.reload();
      await tt.getByTestId('arrive-button').click();
      await expect(tt.getByTestId('presence-status')).toContainText('Presente desde');
      await expect(tt.getByTestId('presence-card')).not.toContainText(/Atraso|min\b/);
      await evidence(tt, '03-tablet-sem-pontualidade');
      await page.reload();
      await expect(page.getByTestId('attendance-Thiago')).toContainText('Atraso operacional');
      await expect(page.getByTestId('attendance-Thiago')).toContainText('20 min');

      // 6. No feriado não há expediente normal: o tablet informa, sem atraso nem ausência.
      await setClock(addDays(DAY, 1), '10:00');
      await tt.reload();
      await expect(tt.getByTestId('presence-holiday')).toContainText('Feriado municipal (E2E)');
      await thiago.context.close();
    } finally {
      await setClock(null);
    }
  });
});
