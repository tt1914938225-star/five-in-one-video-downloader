import type { Config, Context } from "@netlify/functions";

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

function cleanInput(text: unknown) {
  const s = String(text || "").trim();
  const m = s.match(/https?:\/\/[^\s<>\"'，。；！？、]+/i);
  return (m ? m[0] : s).replace(/[\)\]}>，。；！？、]+$/g, "");
}

function extractAwemeId(url: string) {
  const patterns = [
    /\/(?:video|note|slides)\/(\d{15,22})/i,
    /\/share\/(?:video|note|slides)\/(\d{15,22})/i,
    /[?&](?:modal_id|aweme_id|item_ids?)=(\d{15,22})/i,
    /^(\d{15,22})$/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return "";
}

async function fetchText(url: string, ua = MOBILE_UA) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      "Referer": "https://www.douyin.com/",
      "Cache-Control": "no-cache",
    },
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, url: r.url, text };
}

function balancedObject(text: string, start: number) {
  const first = text.indexOf("{", start);
  if (first < 0) return "";
  let depth = 0, inString = false, quote = "", escaped = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) { inString = false; quote = ""; }
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(first, i + 1);
    }
  }
  return "";
}

function tryJson(raw: string) {
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(decodeURIComponent(raw)); } catch {}
  return null;
}

function extractEmbeddedJson(html: string) {
  const candidates: any[] = [];
  const markers = [
    "window._ROUTER_DATA",
    "window.__ROUTER_DATA__",
    "__UNIVERSAL_DATA_FOR_REHYDRATION__",
    "RENDER_DATA",
  ];
  for (const marker of markers) {
    let pos = 0;
    while ((pos = html.indexOf(marker, pos)) >= 0) {
      const raw = balancedObject(html, pos + marker.length);
      if (raw) {
        const parsed = tryJson(raw);
        if (parsed) candidates.push(parsed);
      }
      pos += marker.length;
    }
  }

  const scriptRe = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html))) {
    const parsed = tryJson(m[1].trim());
    if (parsed) candidates.push(parsed);
  }
  return candidates;
}

function firstUrl(v: any): string {
  if (!v) return "";
  if (typeof v === "string" && /^https?:\/\//i.test(v)) return v.replace(/&amp;/g, "&");
  if (Array.isArray(v)) {
    for (const x of v) { const u = firstUrl(x); if (u) return u; }
  }
  if (typeof v === "object") {
    for (const key of ["url_list", "urlList", "url", "uri_list", "uriList"]) {
      const u = firstUrl(v[key]); if (u) return u;
    }
  }
  return "";
}

function looksLikeItem(o: any) {
  if (!o || typeof o !== "object") return false;
  return !!(o.aweme_id || o.awemeId || o.group_id || o.groupId) && !!(o.video || o.images || o.image_post_info);
}

function findItem(root: any, awemeId: string) {
  const seen = new WeakSet<object>();
  let fallback: any = null;
  function walk(v: any): any {
    if (!v || typeof v !== "object") return null;
    if (seen.has(v)) return null;
    seen.add(v);

    const direct = v.aweme_detail || v.awemeDetail;
    if (direct && typeof direct === "object") return direct;
    if (Array.isArray(v.aweme_details) && v.aweme_details[0]) return v.aweme_details[0];
    if (Array.isArray(v.awemeDetails) && v.awemeDetails[0]) return v.awemeDetails[0];
    if (v.videoInfoRes?.item_list?.[0]) return v.videoInfoRes.item_list[0];
    if (v.videoInfoRes?.itemList?.[0]) return v.videoInfoRes.itemList[0];
    if (v.item_list?.[0] && looksLikeItem(v.item_list[0])) return v.item_list[0];
    if (v.itemList?.[0] && looksLikeItem(v.itemList[0])) return v.itemList[0];

    if (looksLikeItem(v)) {
      const id = String(v.aweme_id || v.awemeId || v.group_id || v.groupId || "");
      if (id === awemeId) return v;
      if (!fallback) fallback = v;
    }
    for (const x of Object.values(v)) {
      const found = walk(x);
      if (found) return found;
    }
    return null;
  }
  return walk(root) || fallback;
}

function collectUrls(v: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  function add(x: any) {
    if (!x) return;
    if (typeof x === "string" && /^https?:\/\//i.test(x)) {
      const u = x.replace(/&amp;/g, "&");
      if (!seen.has(u)) { seen.add(u); out.push(u); }
      return;
    }
    if (Array.isArray(x)) { x.forEach(add); return; }
    if (typeof x === "object") {
      for (const k of ["url_list","urlList","url","play_addr","playAddr","download_addr","downloadAddr"]) add(x[k]);
    }
  }
  add(v);
  return out;
}

function normalizeItem(item: any, awemeId: string, strategy: string) {
  const video = item.video || {};
  const author = item.author || item.authorInfo || {};
  const music = item.music || {};
  const imagesRaw = item.images || item.image_post_info?.images || item.imagePostInfo?.images || [];
  const images: string[] = [];
  for (const img of Array.isArray(imagesRaw) ? imagesRaw : []) {
    const u = firstUrl(img?.url_list || img?.urlList || img?.display_image || img?.displayImage || img);
    if (u && !images.includes(u)) images.push(u);
  }

  const variants: any[] = [];
  const addVariant = (obj: any, label = "") => {
    if (!obj) return;
    const urls = collectUrls(obj.play_addr || obj.playAddr || obj.play_addr_265 || obj.playAddr265 || obj);
    const bitrate = Number(obj.bit_rate || obj.bitRate || obj.bitrate || 0);
    const width = Number(obj.width || video.width || 0);
    const height = Number(obj.height || video.height || 0);
    for (const raw of urls) {
      if (!raw) continue;
      const url = raw.replace("/playwm/", "/play/");
      if (!variants.some(x => x.url === url)) variants.push({ url, bitrate, width, height, label: label || obj.gear_name || obj.gearName || obj.quality_type || "" });
    }
  };

  const bitRate = video.bit_rate || video.bitRate || [];
  if (Array.isArray(bitRate)) bitRate.forEach((x: any) => addVariant(x, x?.gear_name || x?.gearName || ""));
  addVariant(video.play_addr || video.playAddr, "标准");
  addVariant(video.download_addr || video.downloadAddr, "下载地址");

  variants.sort((a,b) => (b.bitrate - a.bitrate) || ((b.width*b.height) - (a.width*a.height)));

  const cover = firstUrl(video.cover) || firstUrl(video.origin_cover || video.originCover) || firstUrl(item.cover) || images[0] || "";
  const title = String(item.desc || item.caption || item.preview_title || item.previewTitle || "抖音作品").trim();
  const authorName = String(author.nickname || author.nick_name || author.name || "").trim();
  const musicUrl = firstUrl(music.play_url || music.playUrl);

  return {
    ok: true,
    platform: "抖音",
    awemeId: String(item.aweme_id || item.awemeId || awemeId),
    type: images.length ? "images" : "video",
    title,
    author: authorName,
    cover,
    videos: images.length ? [] : variants.slice(0, 8),
    images,
    audio: musicUrl ? [musicUrl] : [],
    strategy,
  };
}

async function parseFromSharePages(awemeId: string) {
  const paths = ["share/video", "share/slides", "share/note"];
  const errors: string[] = [];
  for (const path of paths) {
    const urls = [
      `https://www.iesdouyin.com/${path}/${awemeId}/?from_ssr=1`,
      `https://www.iesdouyin.com/${path}/${awemeId}/`,
    ];
    for (const url of urls) {
      try {
        const r = await fetchText(url, MOBILE_UA);
        if (!r.ok || !r.text) { errors.push(`${path}: HTTP ${r.status}`); continue; }
        const blobs = extractEmbeddedJson(r.text);
        for (const blob of blobs) {
          const item = findItem(blob, awemeId);
          if (item) return { item, strategy: `iesdouyin:${path}` };
        }
        const encoded = r.text.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/i)?.[1];
        if (encoded) {
          const raw = encoded.replace(/;\s*$/, "").trim();
          const parsed = tryJson(raw);
          if (parsed) {
            const item = findItem(parsed, awemeId);
            if (item) return { item, strategy: `iesdouyin:${path}:router` };
          }
        }
        errors.push(`${path}: no item`);
      } catch (e: any) {
        errors.push(`${path}: ${e?.message || e}`);
      }
    }
  }
  throw new Error(errors.slice(0, 6).join(" | "));
}

async function parseFromDesktopPage(awemeId: string) {
  const url = `https://www.douyin.com/video/${awemeId}`;
  const r = await fetchText(url, DESKTOP_UA);
  if (!r.ok) throw new Error(`desktop HTTP ${r.status}`);
  const blobs = extractEmbeddedJson(r.text);
  for (const blob of blobs) {
    const item = findItem(blob, awemeId);
    if (item) return { item, strategy: "douyin:ssr" };
  }
  throw new Error("desktop SSR 未找到作品数据");
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return Response.json({ ok:false, error:"Method not allowed" }, { status:405 });
  try {
    const body = await req.json();
    const input = cleanInput(body?.url);
    if (!/^https?:\/\//i.test(input)) return Response.json({ ok:false, error:"链接格式不正确" }, { status:400 });

    let awemeId = extractAwemeId(input);
    let finalUrl = input;
    if (!awemeId) {
      const resolved = await fetchText(input, MOBILE_UA);
      finalUrl = resolved.url || input;
      awemeId = extractAwemeId(finalUrl) || extractAwemeId(resolved.text);
      if (!awemeId) {
        const m = resolved.text.match(/(?:aweme_id|awemeId)["'=: ]+(\d{15,22})/i);
        if (m) awemeId = m[1];
      }
    }
    if (!awemeId) return Response.json({ ok:false, error:"短链已解析，但无法提取作品 ID", finalUrl }, { status:422 });

    const errors: string[] = [];
    try {
      const { item, strategy } = await parseFromSharePages(awemeId);
      return Response.json(normalizeItem(item, awemeId, strategy));
    } catch (e: any) { errors.push(`share: ${e?.message || e}`); }

    try {
      const { item, strategy } = await parseFromDesktopPage(awemeId);
      return Response.json(normalizeItem(item, awemeId, strategy));
    } catch (e: any) { errors.push(`ssr: ${e?.message || e}`); }

    return Response.json({ ok:false, error:"自建抖音解析失败", awemeId, finalUrl, details:errors }, { status:502 });
  } catch (e: any) {
    return Response.json({ ok:false, error:e?.message || "抖音解析失败" }, { status:500 });
  }
};

export const config: Config = { path: "/api/douyin-parse" };
