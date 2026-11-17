/** Melhoria 87: chave do tema e o script que aplica o tema antes da primeira pintura. */
export const THEME_KEY = 'cenario.tema';

/** Roda antes da primeira pintura (sem piscar branco no modo escuro). */
export const THEME_PREPAINT = `(function(){try{var p=location.pathname;if(!/^\\/painel/.test(p))return;var c=localStorage.getItem('${THEME_KEY}');if(c==='escuro'||(c==='sistema'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.tema='escuro';}catch(e){}})();`;
