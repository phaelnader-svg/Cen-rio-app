import type { Metadata } from 'next';
import { GameApp } from '@/components/game/game-app';

export const metadata: Metadata = { title: 'Jogo' };

export default function Page() {
  return <GameApp />;
}
