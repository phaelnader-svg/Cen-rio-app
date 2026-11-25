import { createHash } from 'node:crypto';
import { skillMarkdown, skillsIndex } from '@/components/site/agentes';
import { preflight, publicJson } from '@/lib/agentes-http';

/** Índice de habilidades (Agent Skills Discovery 0.2.0); digest = SHA-256 do SKILL.md servido. */
export const dynamic = 'force-static';
export function GET() {
  const digest = `sha256:${createHash('sha256').update(skillMarkdown(), 'utf8').digest('hex')}`;
  return publicJson(skillsIndex(digest));
}
export const OPTIONS = preflight;
