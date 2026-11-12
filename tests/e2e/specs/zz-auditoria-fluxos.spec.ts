import { tmpdir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';
import { openServiceOrder } from './os-helpers';

/**
 * Auditoria funcional F′ — fluxos interativos pela interface real que a navegação geral não aciona:
 * entrada/saída e sessão, validações, clientes (cadastrar, buscar, abrir, editar), minha conta
 * (troca de senha de um usuário HML-), funções (criar pela tela) e fotos (enviar, ampliar, remover,
 * arquivo inexistente). Cada passo registra o observado em test-results/auditoria/fluxos.json.
 * Só dados `HML-`. Arquivo inexistente: o arquivo físico é apagado SÓ no armazenamento do E2E.
 */
const origin = `http://localhost:${E2E.webPort}`;
const FIXTURE = fileURLToPath(new URL('../fixtures/foto-gps.jpg', import.meta.url));
const STORAGE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../storage-e2e');
// Fora de test-results (o Playwright limpa essa pasta): uma linha JSON por passo, gravada na hora.
const OUT = process.env.AUDITORIA_SAIDA ?? `${tmpdir()}/cenario-auditoria`;
const anota = (fluxo: string, passo: string, esperado: string, observado: string, ok: boolean) => {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(
    `${OUT}/fluxos.jsonl`,
    JSON.stringify({ fluxo, passo, esperado, observado, ok }) + '\n',
  );
  expect.soft(ok, `${fluxo} — ${passo}: esperado ${esperado}; observado ${observado}`).toBe(true);
};

const tag = () => Date.now().toString(36);
async function call(page: Page, method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

test('entrada, validação, saída e sessão', async ({ page }) => {
  const F = 'Acesso';
  await page.goto('/entrar');
  await page.getByRole('button', { name: 'Entrar' }).click();
  const vazio = await page.locator('body').innerText();
  anota(
    F,
    'enviar vazio',
    'mensagens de campo obrigatório',
    /obrigat|informe|inválid/i.test(vazio) ? 'mensagens exibidas' : 'nenhuma mensagem',
    /obrigat|informe|inválid/i.test(vazio),
  );
  await page.getByLabel('E-mail').fill(E2E.admin.email);
  await page.getByLabel('Senha').fill('senha-errada-hml');
  await page.getByRole('button', { name: 'Entrar' }).click();
  const erro = page.getByText('E-mail ou senha incorretos.');
  const viu = await erro
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(
    F,
    'senha errada',
    '"E-mail ou senha incorretos."',
    viu ? 'mensagem exibida' : 'sem mensagem',
    viu,
  );
  anota(
    F,
    'senha errada não entra',
    'continua em /entrar',
    page.url().replace(origin, ''),
    /\/entrar/.test(page.url()),
  );

  await loginAdmin(page);
  anota(F, 'entrar', '/painel', page.url().replace(origin, ''), /\/painel$/.test(page.url()));
  await page.getByRole('button', { name: 'Sair' }).first().click();
  await page.waitForURL(/\/entrar/, { timeout: 10_000 }).catch(() => undefined);
  anota(
    F,
    'sair',
    '/entrar?motivo=saiu',
    page.url().replace(origin, ''),
    /\/entrar\?motivo=saiu/.test(page.url()),
  );
  await page.goto('/painel/os');
  await page.waitForTimeout(2500);
  anota(
    F,
    'painel depois de sair',
    'volta para /entrar',
    page.url().replace(origin, ''),
    /\/entrar/.test(page.url()),
  );
  const api = await page.request.get('/api/v1/service-orders', { headers: { origin } });
  anota(F, 'API depois de sair', '401', String(api.status()), api.status() === 401);
});

test('perfil sem painel: mensagem clara na tela de entrada', async ({ page, browser }) => {
  const F = 'Acesso';
  await loginAdmin(page);
  const roles = (await (await page.request.get('/api/roles', { headers: { origin } })).json()) as {
    id: string;
    key: string | null;
  }[];
  const tap = roles.find((r) => r.key === 'tapeceiro')!;
  const t = tag();
  const email = `hml-tablet-${t}@hml.teste.local`;
  await call(page, 'POST', '/api/employees', {
    fullName: `HML-Tablet ${t}`,
    displayName: 'HML-Tablet',
    jobTitle: 'Teste',
    color: '#445566',
    roleIds: [tap.id],
    email,
    password: 'SenhaHml12345',
  });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto('/entrar');
  await p.getByLabel('E-mail').fill(email);
  await p.getByLabel('Senha').fill('SenhaHml12345');
  await p.getByRole('button', { name: 'Entrar' }).click();
  const msg = await p
    .getByText('Seu usuário não tem acesso ao painel administrativo.')
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(
    F,
    'tapeceiro tenta o painel',
    'mensagem "não tem acesso ao painel" e continua em /entrar',
    `${msg ? 'mensagem exibida' : 'sem mensagem'} · ${p.url().replace(origin, '')}`,
    msg && /\/entrar/.test(p.url()),
  );
  await ctx.close();
});

test('clientes: cadastrar, validar, buscar, abrir e editar pela tela', async ({ page }) => {
  const F = 'Clientes';
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  await page.goto('/painel/clientes');
  await page.getByRole('button', { name: 'Novo cliente' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Cadastrar cliente' }).click();
  const msg = await dlg.innerText();
  anota(
    F,
    'cadastrar sem nome',
    'erro de validação no nome',
    /obrigat|informe|nome/i.test(msg) ? 'erro exibido' : 'sem erro',
    /obrigat|informe|mínimo|caracter/i.test(msg),
  );
  const nome = `HML-Cliente Auditoria ${tag()}`;
  await dlg.getByLabel('Nome completo').fill(nome);
  await dlg.getByLabel('Telefone').fill('11 90000-0000');
  const end = await dlg.innerText();
  anota(
    F,
    'endereço obrigatório ou "Cadastrar depois"',
    'opção de cadastrar o endereço depois',
    /Cadastrar depois/.test(end) ? 'opção presente' : 'ausente',
    /Cadastrar depois/.test(end),
  );
  await dlg.getByRole('button', { name: 'Cadastrar depois' }).click();
  await dlg.getByRole('button', { name: /Cadastrar cliente|salvar mesmo assim/ }).click();
  if (
    await dlg
      .getByRole('button', { name: /salvar mesmo assim/ })
      .isVisible()
      .catch(() => false)
  )
    await dlg.getByRole('button', { name: /salvar mesmo assim/ }).click();
  await expect(dlg)
    .toBeHidden({ timeout: 10_000 })
    .catch(() => undefined);
  const fechou = !(await dlg.isVisible().catch(() => false));
  anota(
    F,
    'cadastrar',
    'diálogo fecha e cliente salvo',
    fechou ? 'salvo' : 'diálogo continua aberto',
    fechou,
  );
  await page.goto('/painel/clientes');
  await page.getByPlaceholder('Nome, CPF/CNPJ, telefone ou e-mail').fill(nome);
  const linha = page.getByText(nome).first();
  const achou = await linha
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(F, 'buscar', 'cliente na lista', achou ? 'encontrado' : 'não encontrado', achou);
  if (!achou) return;
  await linha.click();
  await page
    .waitForURL(/\/painel\/clientes\/[0-9a-f-]{36}/, { timeout: 10_000 })
    .catch(() => undefined);
  anota(
    F,
    'abrir',
    '/painel/clientes/<id>',
    page.url().replace(origin, ''),
    /\/painel\/clientes\/[0-9a-f-]{36}/.test(page.url()),
  );
  await page.getByRole('button', { name: 'Editar' }).first().click();
  const ed = page.getByRole('dialog');
  await ed.getByLabel('Observações').fill('HML- editado pela auditoria');
  await ed.getByRole('button', { name: /^Salvar$|salvar mesmo assim/ }).click();
  await expect(ed)
    .toBeHidden({ timeout: 10_000 })
    .catch(() => undefined);
  await page.reload();
  const obs = await page
    .getByText('HML- editado pela auditoria')
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(
    F,
    'editar',
    'observação salva e exibida após recarregar',
    obs ? 'exibida' : 'não exibida',
    obs,
  );
});

test('minha conta: troca de senha de usuário HML- e nova entrada', async ({ page, browser }) => {
  const F = 'Conta';
  await loginAdmin(page);
  const t = tag();
  const role = await call(page, 'POST', '/api/roles', {
    name: `HML-Conta ${t}`,
    permissions: ['painel.acessar', 'os.ver'],
  });
  const email = `hml-conta-${t}@hml.teste.local`;
  await call(page, 'POST', '/api/employees', {
    fullName: `HML-Conta ${t}`,
    displayName: 'HML-Conta',
    jobTitle: 'Teste',
    color: '#445566',
    roleIds: [role.body.id],
    email,
    password: 'SenhaHml12345',
  });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto('/entrar');
  await p.getByLabel('E-mail').fill(email);
  await p.getByLabel('Senha').fill('SenhaHml12345');
  await p.getByRole('button', { name: 'Entrar' }).click();
  await p.waitForURL(/\/painel$/);
  await p.goto('/painel/conta');
  await p.getByLabel('Senha atual').fill('errada-hml-000');
  await p.getByLabel('Nova senha', { exact: true }).fill('NovaSenhaHml123');
  await p.getByLabel('Confirmar nova senha').fill('NovaSenhaHml123');
  await p.getByRole('button', { name: 'Alterar senha' }).click();
  const errada = await p
    .getByText('Senha atual incorreta.')
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(
    F,
    'senha atual errada',
    '"Senha atual incorreta."',
    errada ? 'exibida' : 'não exibida',
    errada,
  );
  await p.getByLabel('Confirmar nova senha').fill('Diferente123456');
  await p.getByLabel('Senha atual').fill('SenhaHml12345');
  await p.getByRole('button', { name: 'Alterar senha' }).click();
  const conf = await p.locator('body').innerText();
  anota(
    F,
    'confirmação diferente',
    'erro de confirmação',
    /não confere|iguais|diferente|coincid/i.test(conf) ? 'erro exibido' : 'sem erro',
    /não confere|iguais|diferente|coincid/i.test(conf),
  );
  await p.getByLabel('Confirmar nova senha').fill('NovaSenhaHml123');
  await p.getByRole('button', { name: 'Alterar senha' }).click();
  const okMsg = await p
    .getByText(/Senha alterada/)
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(F, 'trocar senha', '"Senha alterada…"', okMsg ? 'exibida' : 'não exibida', okMsg);
  await ctx.close();
  const c2 = await browser.newContext();
  const q = await c2.newPage();
  await q.goto('/entrar');
  await q.getByLabel('E-mail').fill(email);
  await q.getByLabel('Senha').fill('NovaSenhaHml123');
  await q.getByRole('button', { name: 'Entrar' }).click();
  const entrou = await q
    .waitForURL(/\/painel$/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  anota(F, 'entrar com a nova senha', '/painel', q.url().replace(origin, ''), entrou);
  await c2.close();
});

test('funções: criar perfil HML- pela tela', async ({ page }) => {
  const F = 'Funções';
  await loginAdmin(page);
  await page.goto('/painel/funcoes');
  const corpo = await page.locator('body').innerText();
  const botao = page.getByRole('button', { name: /Nova função|Criar função|Nova/ }).first();
  const temBotao = await botao
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(
    F,
    'abrir funções',
    'lista e botão de nova função',
    temBotao ? 'ok' : `sem botão (${corpo.slice(0, 80)})`,
    temBotao,
  );
  if (!temBotao) return;
  await botao.click();
  const dlg = page.getByRole('dialog');
  const nome = `HML-Funcao ${tag()}`;
  await dlg.getByLabel(/Nome/).first().fill(nome);
  const caixas = dlg.getByRole('checkbox');
  if ((await caixas.count()) > 0)
    await caixas
      .first()
      .check()
      .catch(() => undefined);
  await dlg
    .getByRole('button', { name: /Salvar|Criar/ })
    .last()
    .click();
  await expect(dlg)
    .toBeHidden({ timeout: 10_000 })
    .catch(() => undefined);
  const apareceu = await page
    .getByText(nome)
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(F, 'criar função', 'função na lista', apareceu ? 'na lista' : 'não apareceu', apareceu);
});

test('fotos: enviar, ampliar, remover e arquivo inexistente', async ({ page }) => {
  const F = 'Fotos';
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const so = await openServiceOrder(page, `HML-Fotos ${tag()}`);
  const erros5xx: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500)
      erros5xx.push(`${r.url().replace(origin, '')} → ${r.status()}`);
  });
  await page.goto(`/painel/os/${so.id}?tab=pecas`);
  await page.getByLabel('Selecionar fotos').first().setInputFiles(FIXTURE);
  const lista = page.getByTestId('photo-list').first();
  const ampliar = lista.getByRole('button', { name: /Ampliar/ });
  const enviou = await ampliar
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  anota(F, 'enviar foto', 'miniatura na galeria', enviou ? 'exibida' : 'não exibida', enviou);
  await ampliar.first().click();
  const viewer = await page
    .getByTestId('photo-viewer')
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(F, 'ampliar', 'visualizador abre', viewer ? 'abriu' : 'não abriu', viewer);
  await page.keyboard.press('Escape');
  let foto: { id: string; url: string } | undefined;
  for (const [tipo, id] of [
    ['SERVICE_ORDER', so.id],
    ...so.items.map((i: { id: string }) => ['SERVICE_ORDER_ITEM', i.id]),
  ] as [string, string][]) {
    const l = await call(page, 'GET', `/api/v1/attachments?entityType=${tipo}&entityId=${id}`);
    const f = (l.body as { id: string; url: string }[] | null)?.[0];
    if (f) {
      foto = f;
      break;
    }
  }
  const lst = { status: 200, body: foto ? [foto] : [] };
  anota(
    F,
    'foto listada pela API',
    '1 foto',
    String((lst.body as unknown[] | null)?.length ?? lst.status),
    !!foto,
  );
  if (!foto) return;
  const fileId = foto.url.split('/').pop()!;

  // Arquivo inexistente: apaga só o arquivo físico (armazenamento do E2E) e abre a OS de novo.
  const fisico = `${STORAGE}/attachment/${fileId}`;
  const miniatura = `${STORAGE}/attachment-thumb/${fileId}`;
  anota(
    F,
    'arquivo físico existe',
    'presente em storage-e2e',
    existsSync(fisico) ? 'presente' : 'ausente',
    existsSync(fisico),
  );
  rmSync(fisico, { force: true });
  rmSync(miniatura, { force: true });
  const original = await page.request.get(`/api/files/${fileId}`, { headers: { origin } });
  const thumb = await page.request.get(`/api/files/${fileId}/miniatura`, { headers: { origin } });
  anota(
    F,
    'abrir foto cujo arquivo sumiu',
    '404 (ou erro tratado)',
    `HTTP ${original.status()}`,
    original.status() === 404,
  );
  anota(
    F,
    'miniatura cujo arquivo sumiu',
    '404 (ou erro tratado)',
    `HTTP ${thumb.status()}`,
    thumb.status() === 404,
  );
  await page.reload();
  await page.waitForTimeout(2000);
  const tela = await page.locator('body').innerText();
  anota(
    F,
    'OS com foto sem arquivo',
    'página continua utilizável',
    /Application error|Algo deu errado/i.test(tela) ? 'tela de erro' : 'página utilizável',
    !/Application error|Algo deu errado/i.test(tela),
  );

  // Remover pela tela (U1): pede confirmação; "Manter foto" não remove.
  await lista.getByRole('button', { name: 'Remover foto' }).first().click();
  const conf = page.getByRole('dialog', { name: 'Remover foto?' });
  const pediu = await conf
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  anota(
    F,
    'remover pede confirmação',
    'diálogo "Remover foto?"',
    pediu ? 'exibido' : 'removeu direto',
    pediu,
  );
  await conf.getByRole('button', { name: 'Manter foto' }).click();
  await page.waitForTimeout(800);
  const mantida = await ampliar.count();
  anota(
    F,
    'cancelar a remoção',
    'foto continua na galeria',
    `${mantida} na galeria`,
    mantida === 1,
  );
  await lista.getByRole('button', { name: 'Remover foto' }).first().click();
  await page.getByTestId('confirmar-remover-foto').click();
  await expect(ampliar)
    .toHaveCount(0, { timeout: 10_000 })
    .catch(() => undefined);
  const restantes = await ampliar.count();
  anota(F, 'remover foto', 'some da galeria', `${restantes} na galeria`, restantes === 0);
  const depois = await page.request.get(`/api/files/${fileId}`, { headers: { origin } });
  anota(F, 'foto removida pela URL', '404', `HTTP ${depois.status()}`, depois.status() === 404);
  anota(
    F,
    'respostas 5xx durante o fluxo',
    'nenhuma fora do caso do arquivo inexistente',
    erros5xx.join('; ') || 'nenhuma',
    erros5xx.every((e) => e.includes(fileId)),
  );
});

test('permissões corrigidas: menu e telas por perfil (B1, B2, B5, B6)', async ({
  page,
  browser,
}) => {
  const F = 'Permissões';
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  const t = tag();
  const perfil = async (nome: string, perms: string[]) => {
    const role = await call(page, 'POST', '/api/roles', {
      name: `${nome} ${t}`,
      permissions: ['painel.acessar', ...perms],
    });
    const email = `${nome.toLowerCase()}-${t}@hml.teste.local`;
    await call(page, 'POST', '/api/employees', {
      fullName: `${nome} ${t}`,
      displayName: nome.slice(0, 40),
      jobTitle: 'Teste',
      color: '#445566',
      roleIds: [role.body.id],
      email,
      password: 'SenhaHml12345',
    });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const r403: string[] = [];
    p.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() === 403) r403.push(r.url().replace(origin, ''));
    });
    await p.goto('/entrar');
    await p.getByLabel('E-mail').fill(email);
    await p.getByLabel('Senha').fill('SenhaHml12345');
    await p.getByRole('button', { name: 'Entrar' }).click();
    await p.waitForURL(/\/painel$/);
    const menu = await p
      .getByRole('navigation', { name: 'Navegação principal' })
      .first()
      .locator('a[href^="/painel"]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    const abrir = async (rota: string) => {
      r403.length = 0;
      await p.goto(rota);
      await p.waitForLoadState('networkidle').catch(() => undefined);
      await p.waitForTimeout(500);
      return { texto: await p.locator('body').innerText(), r403: [...r403] };
    };
    return { menu, abrir, fechar: () => ctx.close() };
  };

  // B1
  const soPedidos = await perfil('HML-SoPedidos', ['pedidos.ver', 'pedidos.gerenciar']);
  anota(
    F,
    'B1 sem retiradas.gerenciar',
    'sem "Novo serviço" no menu',
    soPedidos.menu.includes('/painel/servicos/novo') ? 'no menu' : 'fora do menu',
    !soPedidos.menu.includes('/painel/servicos/novo'),
  );
  await soPedidos.fechar();
  const novoServico = await perfil('HML-NovoServico', [
    'pedidos.ver',
    'pedidos.gerenciar',
    'retiradas.gerenciar',
    'retiradas.ver',
    'clientes.ver',
  ]);
  const ns = await novoServico.abrir('/painel/servicos/novo');
  anota(
    F,
    'B1 com as duas permissões',
    '"Novo serviço" no menu e tela sem 403',
    `${novoServico.menu.includes('/painel/servicos/novo') ? 'no menu' : 'fora do menu'} · 403: ${ns.r403.join(', ') || 'nenhum'}`,
    novoServico.menu.includes('/painel/servicos/novo') && ns.r403.length === 0,
  );
  await novoServico.fechar();

  // B2
  const leitura = await perfil('HML-SoOs', ['os.ver']);
  const rm = await leitura.abrir('/painel/recebimento-materiais');
  anota(
    F,
    'B2 sem estoque/compras',
    'item no menu (qualquer funcionário recebe), tela sem 403 e sem a lista de conferência',
    `${leitura.menu.includes('/painel/recebimento-materiais') ? 'no menu' : 'fora'} · 403: ${rm.r403.join(', ') || 'nenhum'}`,
    leitura.menu.includes('/painel/recebimento-materiais') && rm.r403.length === 0,
  );
  // B5
  for (const rota of ['/painel/dispositivos', '/painel/sincronizacao']) {
    const v = await leitura.abrir(rota);
    const negado = /Acesso negado/.test(v.texto) && /não tem permissão/.test(v.texto);
    anota(
      F,
      `B5 ${rota} sem permissão`,
      'aviso "Acesso negado", sem 403 e sem dados',
      `${negado ? 'aviso exibido' : 'sem aviso'} · 403: ${v.r403.join(', ') || 'nenhum'}`,
      negado && v.r403.length === 0,
    );
  }
  // B6 — proibido
  anota(
    F,
    'B6 sem pedidos.ver nem devolucoes.gerenciar',
    'sem "Devoluções" no menu',
    leitura.menu.includes('/painel/devolucoes') ? 'no menu' : 'fora do menu',
    !leitura.menu.includes('/painel/devolucoes'),
  );
  await leitura.fechar();
  const estoque = await perfil('HML-Estoque', ['estoque.ver']);
  const rmE = await estoque.abrir('/painel/recebimento-materiais');
  anota(
    F,
    'B2 com estoque.ver',
    'tela sem 403 (lista de conferência permitida)',
    `403: ${rmE.r403.join(', ') || 'nenhum'}`,
    rmE.r403.length === 0,
  );
  await estoque.fechar();
  // B6 — permitido só para consultar
  const consulta = await perfil('HML-PedidosVer', ['pedidos.ver']);
  const dv = await consulta.abrir('/painel/devolucoes');
  anota(
    F,
    'B6 com pedidos.ver',
    '"Devoluções" no menu, consulta sem 403 e sem botão de registrar',
    `${consulta.menu.includes('/painel/devolucoes') ? 'no menu' : 'fora'} · 403: ${dv.r403.join(', ') || 'nenhum'} · botão: ${/Registrar devolução/.test(dv.texto) ? 'sim' : 'não'}`,
    consulta.menu.includes('/painel/devolucoes') &&
      dv.r403.length === 0 &&
      !/Registrar devolução/.test(dv.texto),
  );
  await consulta.fechar();
  // B5 / B6 — permitido para quem gerencia
  const gestorDev = await perfil('HML-Devolucoes', [
    'devolucoes.gerenciar',
    'dispositivos.ver',
    'sincronizacao.diagnosticar',
  ]);
  const dv2 = await gestorDev.abrir('/painel/devolucoes');
  anota(
    F,
    'B6 com devolucoes.gerenciar',
    'botão "Registrar devolução"',
    /Registrar devolução/.test(dv2.texto) ? 'exibido' : 'ausente',
    /Registrar devolução/.test(dv2.texto),
  );
  for (const rota of ['/painel/dispositivos', '/painel/sincronizacao']) {
    const v = await gestorDev.abrir(rota);
    anota(
      F,
      `B5 ${rota} com permissão`,
      'conteúdo normal, sem aviso de acesso negado',
      /Acesso negado/.test(v.texto) ? 'aviso indevido' : 'conteúdo normal',
      !/Acesso negado/.test(v.texto) && v.r403.length === 0,
    );
  }
  await gestorDev.fechar();
});
