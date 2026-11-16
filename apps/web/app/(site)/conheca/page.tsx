import { Landing } from '@/components/site/landing';
import { siteMode } from '@/components/site/config';

export default function Page() {
  return <Landing preview={siteMode() === 'preview'} />;
}
