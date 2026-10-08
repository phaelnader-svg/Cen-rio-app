import { describe, expect, it } from 'vitest';
import { describeUserAgent, initials, relativeTime } from '../lib/format';

describe('Formatação', () => {
  it('iniciais', () => {
    expect(initials('Ricardo')).toBe('R');
    expect(initials('João da Silva')).toBe('JD');
  });
  it('tempo relativo', () => {
    expect(relativeTime(null)).toBe('nunca');
    expect(relativeTime(new Date().toISOString())).toBe('agora mesmo');
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('há 5 min');
  });
  it('descrição de navegador', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      ),
    ).toBe('Chrome · Android');
  });
});
