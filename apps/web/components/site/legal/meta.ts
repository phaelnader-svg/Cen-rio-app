import type { Metadata } from 'next';
import { SITE_URL } from '../config';
import { legalMode } from './legal';

/** Metadados das páginas legais: título, descrição e indexação só quando estão no ar. */
export async function legalMetadata(
  path: string,
  title: string,
  description: string,
): Promise<Metadata> {
  return {
    metadataBase: new URL(SITE_URL),
    title: { absolute: `${title} · Cenário Gestão` },
    description,
    alternates: { canonical: path },
    robots:
      (await legalMode()) === 'live'
        ? { index: true, follow: true }
        : { index: false, follow: false },
  };
}
