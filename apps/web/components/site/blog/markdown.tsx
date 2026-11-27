import { Fragment, type ReactNode } from 'react';

/**
 * Markdown simples dos artigos, convertido direto em elementos React (sem HTML cru, então nada
 * do texto vira script). Aceita: ## e ### títulos, parágrafos, listas com "-" ou "1.", "> " citação,
 * "---" divisória, ![texto](imagem) numa linha sozinha, **negrito**, *itálico* e [link](endereço).
 */

const SAFE_URL = /^(https:\/\/|\/(?!\/)|#|mailto:)/;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{inline(m[1], k)}</strong>);
    else if (m[2] !== undefined) out.push(<em key={k}>{inline(m[2], k)}</em>);
    else {
      const href = m[4]!;
      const label = inline(m[3]!, k);
      if (!SAFE_URL.test(href)) out.push(<Fragment key={k}>{label}</Fragment>);
      else {
        const external = href.startsWith('https://');
        out.push(
          <a
            key={k}
            href={href}
            className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {label}
          </a>,
        );
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: 'h2' | 'h3' | 'p' | 'quote'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'hr' }
  | { t: 'img'; alt: string; src: string };

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^###\s+(.*)$/))) {
      flush();
      blocks.push({ t: 'h3', text: m[1]! });
    } else if ((m = line.match(/^#{1,2}\s+(.*)$/))) {
      flush();
      blocks.push({ t: 'h2', text: m[1]! });
    } else if (/^(-{3,}|\*{3,})$/.test(line)) {
      flush();
      blocks.push({ t: 'hr' });
    } else if ((m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) {
      flush();
      if (SAFE_URL.test(m[2]!)) blocks.push({ t: 'img', alt: m[1]!, src: m[2]! });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush();
      const prev = blocks.at(-1);
      if (prev?.t === 'quote') prev.text += ` ${m[1]}`;
      else blocks.push({ t: 'quote', text: m[1]! });
    } else if ((m = line.match(/^[-*]\s+(.*)$/)) || (m = line.match(/^\d+[.)]\s+(.*)$/))) {
      flush();
      const t = /^\d/.test(line) ? 'ol' : 'ul';
      const prev = blocks.at(-1);
      if (prev && prev.t === t) prev.items.push(m[1]!);
      else blocks.push({ t, items: [m[1]!] });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

export function Markdown({ source }: { source: string }) {
  return (
    <>
      {parseBlocks(source).map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case 'h2':
            return (
              <h2 key={k} className="mt-10 text-2xl font-semibold tracking-tight text-ink">
                {inline(b.text, k)}
              </h2>
            );
          case 'h3':
            return (
              <h3 key={k} className="mt-8 text-xl font-semibold tracking-tight text-ink">
                {inline(b.text, k)}
              </h3>
            );
          case 'p':
            return (
              <p key={k} className="mt-5">
                {inline(b.text, k)}
              </p>
            );
          case 'quote':
            return (
              <blockquote
                key={k}
                className="mt-6 border-l-4 border-brand-200 pl-4 font-medium text-ink"
              >
                {inline(b.text, k)}
              </blockquote>
            );
          case 'ul':
          case 'ol': {
            const List = b.t;
            return (
              <List
                key={k}
                className={`mt-5 space-y-2 pl-6 ${b.t === 'ul' ? 'list-disc' : 'list-decimal'} marker:text-ink-muted`}
              >
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${k}-${j}`)}</li>
                ))}
              </List>
            );
          }
          case 'hr':
            return <hr key={k} className="my-10 border-line" />;
          case 'img':
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={k}
                src={b.src}
                alt={b.alt}
                loading="lazy"
                className="mt-6 block h-auto w-full rounded-xl border border-line"
              />
            );
        }
      })}
    </>
  );
}
