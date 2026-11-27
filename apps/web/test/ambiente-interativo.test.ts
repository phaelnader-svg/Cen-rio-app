/**
 * Botão "Acessar ambiente interativo": o caminho do Cenário redireciona para a entrada do
 * Firma Viva com a conta do Cenário. O botão abre em nova guia, ao lado do sininho.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET } from '../app/ambiente-interativo/route';
import { firmaEntryUrl } from '../lib/ambiente-interativo';

describe('ambiente interativo', () => {
  it('usa FIRMA_WEB_URL (https) e cai no endereço público quando ausente ou inseguro', () => {
    expect(firmaEntryUrl({})).toBe('https://firmaviva.com.br/api/entrar/cenario');
    expect(firmaEntryUrl({ FIRMA_WEB_URL: 'https://previa.firmaviva.com.br/' })).toBe(
      'https://previa.firmaviva.com.br/api/entrar/cenario',
    );
    expect(firmaEntryUrl({ FIRMA_WEB_URL: 'http://localhost:3100' })).toBe(
      'http://localhost:3100/api/entrar/cenario',
    );
    expect(firmaEntryUrl({ FIRMA_WEB_URL: 'http://firmaviva.com.br' })).toBe(
      'https://firmaviva.com.br/api/entrar/cenario',
    );
    expect(firmaEntryUrl({ FIRMA_WEB_URL: 'javascript:alert(1)' })).toBe(
      'https://firmaviva.com.br/api/entrar/cenario',
    );
  });

  it('a rota redireciona sem cache', () => {
    const r = GET();
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/\/api\/entrar\/cenario$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('botão Firma Viva ao lado do sininho, em nova guia', () => {
    const shell = readFileSync(resolve(__dirname, '../components/admin/shell.tsx'), 'utf8');
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    // Etapa 5 (lista de 53): o botão virou o componente FirmaHeaderButton (com o teste de 7 dias).
    const button = header.indexOf('<FirmaHeaderButton');
    expect(button).toBeGreaterThan(-1);
    expect(button).toBeLessThan(header.indexOf('<PanelNotifications />'));
    // Complemento "Ambiente interativo": o botão segue a funcionalidade da empresa e só o dono vê.
    expect(header).toContain('gameOn={modules.ambiente_interativo}');
    expect(header).toContain("perms.has('empresa.configurar')");
    const comp = readFileSync(resolve(__dirname, '../components/billing/firma-trial.tsx'), 'utf8');
    const link = comp.slice(comp.indexOf('export function FirmaHeaderButton'));
    expect(link).toContain('data-testid="ambiente-interativo"');
    // Melhoria 159: o botão leva o nome do produto e o verde da marca.
    expect(link).toContain('Firma Viva');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(comp).toMatch(/const OPEN_LINK =[^;]*bg-brand-700/);
  });
});
