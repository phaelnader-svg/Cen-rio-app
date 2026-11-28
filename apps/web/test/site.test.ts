/**
 * Landing comercial (/conheca): ativação, isolamento e limites do que a página promete.
 * Mesmo estilo dos demais testes do web: sem navegador, pela configuração e pelo código-fonte.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCREENS,
  SIGNUP_PATH,
  SITE,
  annualOffer,
  pendingItems,
  siteMetadata,
  siteMode,
  whatsappUrl,
} from '../components/site/config';

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const SITE_FILES = [
  'components/site/landing.tsx',
  'components/site/config.ts',
  'app/(site)/layout.tsx',
  'app/(site)/conheca/page.tsx',
  'app/page.tsx',
];

describe('ativação da landing', () => {
  const complete = { ...SITE, monthlyPrice: '100', whatsappNumber: '5500000000000' };
  const screens = Object.fromEntries(
    Object.entries(SCREENS).map(([k, s]) => [k, { ...s, src: `/site/${k}.png` }]),
  );

  it('com tudo preenchido, em produção só abre com SITE_COMERCIAL=1', () => {
    expect(pendingItems()).toEqual([]);
    expect(siteMode({ NODE_ENV: 'production' })).toBe('off');
    expect(siteMode({ NODE_ENV: 'production', SITE_COMERCIAL: '1' })).toBe('live');
    expect(siteMode({ NODE_ENV: 'production', SITE_COMERCIAL: '1' }, ['Número do WhatsApp'])).toBe(
      'off',
    );
  });

  it('em produção exige SITE_COMERCIAL=1 e nenhuma pendência', () => {
    const none = pendingItems(complete, screens);
    expect(none).toEqual([]);
    expect(siteMode({ NODE_ENV: 'production' }, none)).toBe('off');
    expect(siteMode({ NODE_ENV: 'production', SITE_COMERCIAL: 'true' }, none)).toBe('off');
    expect(siteMode({ NODE_ENV: 'production', SITE_COMERCIAL: '1' }, none)).toBe('live');
    expect(pendingItems({ ...complete, monthlyPrice: null }, screens)).toEqual([
      'Valor da mensalidade',
    ]);
  });

  it('em desenvolvimento a página é só pré-visualização', () => {
    expect(siteMode({ NODE_ENV: 'development' })).toBe('preview');
  });

  it('sem número configurado não há link de WhatsApp inventado', () => {
    expect(whatsappUrl({ ...SITE, whatsappNumber: null })).toBeNull();
    expect(whatsappUrl(complete)).toBe(
      'https://wa.me/5500000000000?text=Ol%C3%A1!%20Quero%20conhecer%20o%20Cen%C3%A1rio%20Gest%C3%A3o.',
    );
  });

  it('a indexação só é liberada com a landing publicada', () => {
    expect(src('app/(site)/layout.tsx')).toMatch(/siteMetadata\(siteMode\(\) === 'live'\)/);
    expect(siteMetadata(true).robots).toEqual({ index: true, follow: true });
    expect(siteMetadata(false).robots).toEqual({ index: false, follow: false });
    expect(src('app/layout.tsx')).toMatch(/robots: \{ index: false, follow: false \}/);
  });
});

describe('compartilhamento e Google', () => {
  it('/ e /conheca apontam para o mesmo endereço principal e têm prévia com imagem', () => {
    const m = siteMetadata(true);
    expect(m.alternates.canonical).toBe('/');
    expect(m.metadataBase.toString()).toBe('https://cenariogestao.com.br/');
    expect(m.openGraph.images[0]).toMatchObject({ url: '/site/og.png', width: 1200, height: 630 });
    expect(src('app/page.tsx')).toMatch(/siteMetadata\(true\)/);
  });

  it('robots.txt e sitemap.xml existem e deixam o painel fora', () => {
    expect(src('lib/robots.ts')).toMatch(/ROBOTS_DISALLOW = \[\s*'\/painel'/);
    expect(src('app/sitemap.ts')).toMatch(/SITE_URL/);
  });

  it('o botão Criar minha conta abre a tela de entrar já no Criar conta', () => {
    expect(SIGNUP_PATH).toBe('/entrar?criar=1');
    expect(src('components/admin/login.tsx')).toMatch(/params\.get\('criar'\) === '1'/);
  });
});

describe('isolamento e promessas', () => {
  const code = SITE_FILES.map(src).join('\n');

  it('não usa sessão, API, React Query nem tempo real', () => {
    expect(code).not.toMatch(/@\/lib\/(api|hooks|queries|realtime)|@tanstack|fetch\(|useQuery/);
    expect(code).not.toMatch(/^'use client'/m);
  });

  it('não promete nada que ainda não foi decidido', () => {
    expect(code).not.toMatch(
      /gratuit|ilimitad|fidelidade|promoç|plano (básico|profissional|premium)/i,
    );
    // Teste grátis: só o decidido pelo proprietário (7 dias), vindo da configuração.
    expect(src('components/site/landing.tsx')).not.toMatch(/grátis/i);
    expect(SITE.trialDays).toBe(7);
    // Desconto só o anual decidido pelo proprietário, calculado da configuração.
    expect(src('components/site/landing.tsx')).not.toMatch(/desconto|anual/i);
  });

  it('o plano anual é calculado a partir da mensalidade e do desconto', () => {
    expect(annualOffer()).toBe('No anual, R$ 339,15 por mês (R$ 718,20 a menos no ano).');
    expect(annualOffer({ ...SITE, annualDiscountPct: null })).toBeNull();
    expect(annualOffer({ ...SITE, monthlyPrice: null })).toBeNull();
  });

  it('a raiz mostra a landing só quando publicada; senão continua indo para o painel', () => {
    const root = src('app/page.tsx');
    expect(root).toMatch(/if \(siteMode\(\) !== 'live'\) redirect\('\/painel'\)/);
    expect(root).toMatch(/<Landing\s+preview=\{false\}\s+blogOrigem=/);
    expect(root).toMatch(/force-dynamic/);
  });

  it('o topo da landing tem Criar conta (principal) e, do lado, Entrar indo para /entrar', () => {
    const landing = src('components/site/landing.tsx');
    expect(landing).toMatch(
      /href="\/entrar"[\s\S]{0,200}BUTTON_VARIANTS\.secondary[\s\S]{0,200}Entrar/,
    );
    expect(landing).toMatch(/<SignupLink size="sm"[\s\S]{0,80}Criar conta[\s\S]{0,80}<LoginLink/);
  });

  it('a tarja do topo leva ao WhatsApp, fecha no X e não volta para quem fechou', () => {
    const bar = src('components/site/top-bar.tsx');
    expect(bar).toMatch(/localStorage\.setItem\(KEY, '1'\)/);
    expect(bar).toMatch(/Chame no WhatsApp/);
    expect(bar).not.toMatch(/openDemo|demonstração/);
    expect(bar).not.toMatch(/Fale com quem usa/);
    expect(bar).not.toMatch(/sticky|fixed/);
    expect(src('components/site/landing.tsx')).toMatch(/<TopBar href=\{wa\}/);
  });

  it('o botão Chamar no WhatsApp fica flutuando no canto de baixo, à direita, e abre direto o WhatsApp (28/11)', () => {
    const landing = src('components/site/landing.tsx');
    const floatSrc = src('components/site/whatsapp-float.tsx');
    expect(floatSrc).toMatch(/fixed right-4 bottom-4[\s\S]{0,600}Chamar no WhatsApp/);
    expect(floatSrc).not.toMatch(/onClick/);
    expect(landing).toMatch(/<WhatsappFloat href=\{wa\}/);
    expect(landing).toMatch(/<RememberOrigin \/>/);
    expect(landing).not.toMatch(/DemoDialogHost|demoWhatsappUrl|Agendar/);
    expect(landing).not.toMatch(/subtitle="Cenário Estofados"/);
  });
});
