import type { Metadata } from 'next';
import { GameApp } from '@/components/game/game-app';

export const metadata: Metadata = { title: 'Empresa virtual' };

export default function JogoPage() {
  return <GameApp />;
}
