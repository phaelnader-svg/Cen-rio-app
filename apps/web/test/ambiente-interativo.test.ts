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

  it('botão verde ao lado do sininho, em nova guia', () => {
    const shell = readFileSync(resolve(__dirname, '../components/admin/shell.tsx'), 'utf8');
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    const button = header.indexOf('data-testid="ambiente-interativo"');
    expect(button).toBeGreaterThan(-1);
    expect(button).toBeLessThan(header.indexOf('<PanelNotifications />'));
    expect(header).toContain('Acessar ambiente interativo');
    expect(header).toContain('target="_blank"');
    expect(header).toContain('rel="noopener noreferrer"');
    expect(header).toContain('bg-ok-600');
    // Complemento "Ambiente interativo": o botão segue a funcionalidade da empresa.
    expect(header).toContain('modules.ambiente_interativo && (');
  });
});
