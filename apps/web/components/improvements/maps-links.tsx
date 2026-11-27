import clsx from 'clsx';
import { Navigation } from 'lucide-react';

/** Melhoria 106: abrir o endereço no Google Maps ou no Waze (no celular abre o aplicativo). */
export interface MapsAddress {
  street: string;
  number: string;
  district?: string | null;
  city: string;
  state: string;
  postalCode?: string | null;
}

export const addressQuery = (a: MapsAddress) =>
  [`${a.street}, ${a.number}`, a.district, `${a.city} - ${a.state}`, a.postalCode]
    .filter(Boolean)
    .join(', ');

export const googleMapsUrl = (a: MapsAddress) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressQuery(a))}`;

export const wazeUrl = (a: MapsAddress) =>
  `https://waze.com/ul?q=${encodeURIComponent(addressQuery(a))}&navigate=yes`;

/** Roteiro do dia inteiro no Google Maps, na ordem das paradas (até 10 endereços). */
export function googleRouteUrl(stops: MapsAddress[]): string | null {
  const list = stops.slice(0, 10).map(addressQuery);
  if (!list.length) return null;
  const destination = list.at(-1)!;
  const waypoints = list.slice(0, -1).join('|');
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(destination)}${waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ''}`;
}

export function MapsLinks({ address, large }: { address: MapsAddress; large?: boolean }) {
  const cls = clsx(
    'inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface font-semibold text-ink hover:bg-subtle',
    large ? 'h-12 px-4 text-base' : 'h-8 px-2.5 text-xs',
  );
  return (
    <span className="inline-flex flex-wrap gap-2">
      <a href={googleMapsUrl(address)} target="_blank" rel="noopener noreferrer" className={cls}>
        <Navigation className={large ? 'size-5' : 'size-3.5'} aria-hidden /> Google Maps
      </a>
      <a href={wazeUrl(address)} target="_blank" rel="noopener noreferrer" className={cls}>
        <Navigation className={large ? 'size-5' : 'size-3.5'} aria-hidden /> Waze
      </a>
    </span>
  );
}
