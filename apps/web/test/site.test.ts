/**
 * Landing comercial (/conheca): ativação, isolamento e limites do que a página promete.
 * Mesmo estilo dos demais testes do web: sem navegador, pela configuração e pelo código-fonte.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCREENS,
  SITE,
  annualOffer,
  pendingItems,
  siteMode,
  whatsappUrl,
} from '../components/site/config';

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const SITE_FILES = [
  'components/site/landing.tsx',
  'components/site/config.ts',
  'app/(site)/layout.tsx',
  'app/(site)/conheca/page.tsx',
];

describe('ativação da landing', () => {
  const complete = { ...SITE, monthlyPrice: '100', whatsappNumber: '5500000000000' };
  const screens = Object.fromEntries(
    Object.entries(SCREENS).map(([k, s]) => [k, { ...s, src: `/site/${k}.png` }]),
  );

  it('enquanto o WhatsApp está pendente, nada fica ativo em produção', () => {
    expect(pendingItems()).toEqual(['Número do WhatsApp']);
    expect(siteMode({ NODE_ENV: 'production', SITE_COMERCIAL: '1' })).toBe('off');
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
    expect(whatsappUrl()).toBeNull();
    expect(whatsappUrl(complete)).toBe(
      'https://wa.me/5500000000000?text=Ol%C3%A1!%20Quero%20conhecer%20o%20Cen%C3%A1rio%20Gest%C3%A3o.',
    );
  });

  it('a indexação só é liberada com a landing publicada', () => {
    expect(src('app/(site)/layout.tsx')).toMatch(
      /siteMode\(\) === 'live' \? \{ index: true, follow: true \} : \{ index: false, follow: false \}/,
    );
    expect(src('app/layout.tsx')).toMatch(/robots: \{ index: false, follow: false \}/);
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
      /grátis|gratuit|ilimitad|fidelidade|promoç|plano (básico|profissional|premium)/i,
    );
    // Desconto só o anual decidido pelo proprietário, calculado da configuração.
    expect(src('components/site/landing.tsx')).not.toMatch(/desconto|anual/i);
  });

  it('o plano anual é calculado a partir da mensalidade e do desconto', () => {
    expect(annualOffer()).toBe(
      'No plano anual, 15% de desconto: R$ 339,15 por mês, ou R$ 4.069,80 no ano.',
    );
    expect(annualOffer({ ...SITE, annualDiscountPct: null })).toBeNull();
    expect(annualOffer({ ...SITE, monthlyPrice: null })).toBeNull();
  });

  it('a raiz do sistema continua indo para o painel', () => {
    expect(src('app/page.tsx')).toMatch(/redirect\('\/painel'\)/);
  });
});
