import { AppError } from './errors.mts';
import { MAX_ITEMS, type Platform } from './config.mts';
import { item, urls, variants, positive, type MediaItem, type MediaType, type Parsed, type Variant } from './model.mts';

function failed(d: any): boolean {
  return d?.status === false || d?.ok === false || d?.success === false || d?.status === 'error' || (typeof d?.code === 'number' && d.code >= 400);
}
function typeOf(type: unknown): MediaType {
  return type === 'video' || type === 'image' || type === 'audio' ? type : 'unknown';
}
function videoVariants(v: any): Variant[] {
  if (!v) return [];
  const q = v.bit_rate ?? v.bitRate;
  const out = Array.isArray(q) ? q.flatMap(x => variants(x.play_addr ?? x.playAddr, 'video', {
    bitrate: x.bit_rate ?? x.bitRate, width: x.play_addr?.width ?? x.width, height: x.play_addr?.height ?? x.height,
  })) : [];
  out.push(...variants(v.play_addr ?? v.playAddr ?? v.url ?? v, 'video', { width: v.width, height: v.height }));
  return out;
}
export function normalizeDouyin(itemData: any, id: string): Parsed {
  const title = String(itemData.desc || '抖音作品').slice(0, 500);
  const cover = urls(itemData.video?.cover ?? itemData.video?.origin_cover)[0];
  const items: MediaItem[] = [];
  const add = (type: MediaType, sources: Variant[], preview?: string) => { if (sources.length) items.push(item('douyin', title, items.length + 1, type, sources, preview)); };
  const images = itemData.images ?? itemData.image_post_info?.images ?? itemData.imagePostInfo?.images ?? [];
  for (const img of Array.isArray(images) ? images : []) {
    const sources = variants(img.display_image ?? img.displayImage ?? img, 'image');
    const motion = videoVariants(img.video);
    if ((img.is_live_photo === true || img.type === 'live_photo') && sources.length && motion.length) {
      const still = item('douyin', title, items.length + 1, 'image', sources);
      const video = item('douyin', title, items.length + 1, 'video', motion);
      items.push({ ...still, type: 'live_photo', variants: [], image: still, motion: video });
    } else add('image', sources);
  }
  const clips = itemData.video_list ?? itemData.videos;
  if (Array.isArray(clips)) for (const video of clips) add('video', videoVariants(video), cover);
  else if (!images.length || itemData.aweme_type === 0) add('video', videoVariants(itemData.video), cover);
  // Background music alone cannot turn a cover-only post into a successful parse.
  if (items.length) add('audio', variants(itemData.music?.play_url ?? itemData.music?.playUrl, 'audio'));
  return { platform: 'douyin', title, author: String(itemData.author?.nickname || ''), preview: cover, items, strategy: `share-page:${id}`, warnings: [] };
}
export function normalizeProvider(platform: Platform, raw: any): Parsed {
  if (!raw || typeof raw !== 'object' || failed(raw)) throw new AppError('PROVIDER_ERROR', '第三方解析服务返回失败，请稍后重试。', 502);
  const d = raw.result ?? raw.data ?? raw;
  if (failed(d)) throw new AppError('PROVIDER_ERROR', '第三方解析服务返回失败，请稍后重试。', 502);
  const title = String(d.title ?? d.desc ?? raw.title ?? '公开作品').slice(0, 500);
  const preview = urls(d.cover ?? d.thumbnail)[0];
  const result: Parsed = { platform, title, preview, items: [], strategy: 'provider', warnings: [] };
  const add = (type: MediaType, sources: Variant[], cover = preview) => {
    if (sources.length) result.items.push(item(platform, title, result.items.length + 1, type, sources, cover));
  };
  const addImage = (v: any) => {
    const sources = variants(v?.original ?? v?.url_list ?? v?.urlList ?? v?.info_list ?? v?.infoList ?? v, 'image');
    const motion = variants(v?.motion?.variants ?? v?.motion ?? v?.videoUrl ?? v?.video_url ?? v?.video?.url, 'video');
    // Pairing requires explicit metadata AND two resources belonging to the same entry.
    if ((v?.type === 'live_photo' || v?.isLivePhoto === true || v?.is_live_photo === true || v?.livePhoto === true) && sources.length && motion.length) {
      const still = item(platform, title, result.items.length + 1, 'image', sources);
      const video = item(platform, title, result.items.length + 1, 'video', motion);
      result.items.push({ ...still, type: 'live_photo', variants: [], image: still, motion: video });
    } else { add('image', sources); if (motion.length) {
      add('video', motion);
      result.warnings.push('发现未明确标注实况关系的动态资源，已单独列为视频。');
    } }
  };
  // Versioned optional backend contract; no recursive scraping of arbitrary fields.
  if (d.schemaVersion === 1 && Array.isArray(d.items)) {
    for (const entry of d.items) {
      if (entry.type === 'live_photo') {
        addImage({ type: 'live_photo', original: entry.image?.variants, motion: entry.motion?.variants });
      } else add(typeOf(entry.type), variants(entry.variants, typeOf(entry.type)), urls(entry.preview)[0]);
    }
  } else if (platform === 'douyin' && (d.aweme_detail || d.item_list)) {
    return normalizeDouyin(d.aweme_detail ?? d.item_list[0], String(d.aweme_detail?.aweme_id ?? d.item_list[0]?.aweme_id ?? ''));
  } else if (platform === 'instagram') {
    const entries = Array.isArray(d) ? d : Array.isArray(d.media) ? d.media : [];
    for (const entry of entries) add(typeOf(entry.type), variants(entry.variants ?? entry.url, typeOf(entry.type)), urls(entry.thumbnail)[0]);
  } else if (platform === 'twitter') {
    const entries = d.extended_entities?.media ?? d.media;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry.type === 'photo' || entry.type === 'image') add('image', variants(entry.media_url_https ?? entry.url, 'image'));
        else add('video', variants((entry.video_info?.variants ?? entry.variants ?? []).filter((v: any) => !v.content_type || v.content_type === 'video/mp4'), 'video'), urls(entry.media_url_https ?? entry.thumbnail)[0]);
      }
    } else {
      const arr = Array.isArray(d.url) ? d.url : [d.url];
      // Legacy response explicitly has singleton HD + singleton SD for one clip.
      if (arr.length === 2 && urls(arr[0]?.hd).length && urls(arr[1]?.sd).length && !arr[0]?.sd && !arr[1]?.hd) {
        add('video', [...variants(arr[0].hd, 'video', { label: 'HD' }), ...variants(arr[1].sd, 'video', { label: 'SD' })]);
      } else for (const entry of arr) {
        add('video', entry?.hd || entry?.sd ? [...variants(entry.hd, 'video', { label: 'HD' }), ...variants(entry.sd, 'video', { label: 'SD' })] : variants(entry?.variants ?? entry, 'video'));
      }
    }
    for (const v of result.items.flatMap(x => x.variants)) {
      // The source URL's explicit dimensions are evidence; labels alone are not pixels.
      const dimensions = new URL(v.url).pathname.match(/\/(\d{2,5})x(\d{2,5})\//);
      if (dimensions) { v.width ??= positive(dimensions[1]); v.height ??= positive(dimensions[2]); }
    }
  } else if (platform === 'xiaohongshu') {
    const notes = Array.isArray(d.notes) ? d.notes : [d.notes ?? d];
    for (const note of notes) {
      for (const img of note.images ?? note.imageList ?? []) addImage(img);
      const clips = note.videos ?? (note.video ? [note.video] : note.videoUrl ? [note.videoUrl] : []);
      for (const clip of clips) {
        const stream = clip?.media?.stream;
        const streams = stream ? [...(stream.h264 ?? []), ...(stream.h265 ?? [])] : undefined;
        add('video', variants(streams ?? clip?.variants ?? clip, 'video'));
      }
      // Published provider schema calls these downloads, without a guaranteed media type.
      // Preserve each resource and let MIME + byte validation decide; never pair with a cover.
      const downloads = note.downloads ?? [];
      for (const download of downloads) add(typeOf(download.type), variants(download, typeOf(download.type)));
    }
  } else if (platform === 'tiktok') {
    for (const img of d.images ?? []) addImage(img);
    for (const clip of Array.isArray(d.video) ? d.video : d.video ? [d.video] : d.videos ?? []) add('video', variants(clip?.variants ?? clip, 'video'));
    if (result.items.length) for (const audio of d.audio ?? []) add('audio', variants(audio, 'audio'));
  } else if (platform === 'douyin') {
    for (const image of d.images ?? []) addImage(image);
    // links are not always videos: one link may be an image. Probe each before grouping.
    for (const link of d.links ?? []) add(typeOf(link.type), variants(link, typeOf(link.type)));
    for (const clip of d.videos ?? []) add('video', variants(clip?.variants ?? clip, 'video'));
  }
  if (result.items.length > MAX_ITEMS) throw new AppError('TOO_MANY_ITEMS', '作品资源数超过本次解析限制，请拆分作品链接。');
  // Exact URL duplicates only. Cover URLs never enter this collection by themselves.
  const seen = new Set<string>();
  result.items = result.items.filter(entry => {
    const key = entry.type === 'live_photo' ? JSON.stringify(entry.image?.variants) : JSON.stringify(entry.variants.map(v => v.url));
    if (seen.has(key)) return false; seen.add(key); return true;
  });
  result.items.forEach((entry, i) => { entry.index = i + 1; entry.id = `${platform}-${i + 1}`; });
  result.preview ||= result.items.find(entry => entry.preview)?.preview;
  return result;
}
