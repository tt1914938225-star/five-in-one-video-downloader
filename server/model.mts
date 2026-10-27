import type { Platform } from './config.mts';
export type MediaType = 'video' | 'image' | 'audio' | 'unknown';
export interface Variant {
  url: string; type?: MediaType; width?: number; height?: number;
  bitrate?: number; label?: string;
}
export interface MediaItem {
  id: string; index: number; type: MediaType | 'live_photo';
  title: string; platform: Platform; preview?: string;
  variants: Variant[]; image?: MediaItem; motion?: MediaItem;
}
export interface Parsed {
  platform: Platform; title: string; author?: string; preview?: string;
  items: MediaItem[]; strategy: string; warnings: string[];
}
export const positive = (v: unknown) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined;
export function urls(value: any): string[] {
  if (typeof value === 'string') return /^https:\/\//i.test(value) ? [value.replace(/&amp;/g, '&')] : [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(urls))];
  if (!value || typeof value !== 'object') return [];
  return [...new Set(['url_list','urlList','url','masterUrl','master_url','backupUrls','backup_urls'].flatMap(key => urls(value[key])))];
}
export function variants(value: any, type: MediaType, inherited: any = {}): Variant[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(v => urls(v).map(url => ({
    url, type, width: positive(v?.width ?? inherited.width), height: positive(v?.height ?? inherited.height),
    bitrate: positive(v?.bitrate ?? v?.bit_rate ?? inherited.bitrate),
    label: typeof v?.quality === 'string' ? v.quality : inherited.label,
  })));
}
export function item(platform: Platform, title: string, index: number, type: MediaType, sources: Variant[], preview?: string): MediaItem {
  return { id: `${platform}-${index}`, index, type, title, platform, variants: sources, preview };
}
export function rank(a: Variant, b: Variant) {
  const area = (v: Variant) => (v.width || 0) * (v.height || 0);
  const tier = (v: Variant) => /^(hd|high|高清)$/i.test(v.label || '') ? 2 : /^(sd|low|标清)$/i.test(v.label || '') ? 1 : 0;
  return area(b) - area(a) || (b.bitrate || 0) - (a.bitrate || 0) || tier(b) - tier(a);
}
