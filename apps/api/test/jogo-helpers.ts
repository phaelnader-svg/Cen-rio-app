import { type GameSpaceDto, type LayoutContent, clearanceAround, footprint } from '@cenario/shared';

export { clearanceAround, footprint };
export const contentOfSpace = (s: GameSpaceDto): LayoutContent =>
  JSON.parse(JSON.stringify(s)) as LayoutContent;
