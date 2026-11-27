import { legalMode } from '@/components/site/legal/legal';
import { blogOrigemDe } from '@/components/site/blog/artigos';
import { Landing } from '@/components/site/landing';
import { siteMode } from '@/components/site/config';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Page({ searchParams }: Props) {
  return (
    <Landing
      preview={siteMode() === 'preview'}
      blogOrigem={blogOrigemDe(await searchParams)}
      legal={await legalMode()}
    />
  );
}
