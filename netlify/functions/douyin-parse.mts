import type { Config, Context } from "@netlify/functions";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

function cleanInput(text: unknown) {
  const s = String(text || "").trim();
  const m = s.match(/https?:\/\/[^\s<>\"'，。；！？、]+/i);
  return (m ? m[0] : s).replace(/[\)\]}>，。；！？、]+$/g, "");
}

function extractAwemeId(text: string) {
  const patterns = [
    /\/(?:video|note|slides)\/(\d{15,22})/i,
    /\/share\/(?:video|note|slides)\/(\d{15,22})/i,
    /[?&](?:modal_id|aweme_id|item_id|item_ids)=(\d{15,22})/i,
    /["']aweme_id["']\s*:\s*["'](\d{15,22})["']/i,
    /["']awemeId["']\s*:\s*["'](\d{15,22})["']/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return "";
}

async function fetchPage(url: string) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": MOBILE_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      Referer: "https://www.douyin.com/",
      "Cache-Control": "no-cache",
    },
  });

  return {
    ok: r.ok,
    status: r.status,
    url: r.url,
    text: await r.text(),
  };
}

function extractRouterData(html: string) {
  const marker = "window._ROUTER_DATA";
  const pos = html.indexOf(marker);
  if (pos < 0) return null;

  const eq = html.indexOf("=", pos);
  if (eq < 0) return null;

  const end = html.indexOf("</script>", eq);
  if (end < 0) return null;

  let raw = html.slice(eq + 1, end).trim();
  raw = raw.replace(/;\s*$/, "");

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function findVideoInfoRes(root: any): any {
  if (!root || typeof root !== "object") return null;

  if (root.videoInfoRes?.item_list?.[0]) {
    return root.videoInfoRes.item_list[0];
  }

  if (root.videoInfoRes?.itemList?.[0]) {
    return root.videoInfoRes.itemList[0];
  }

  if (Array.isArray(root.item_list) && root.item_list[0]?.video) {
    return root.item_list[0];
  }

  if (Array.isArray(root.itemList) && root.itemList[0]?.video) {
    return root.itemList[0];
  }

  for (const value of Object.values(root)) {
    const found = findVideoInfoRes(value);
    if (found) return found;
  }

  return null;
}

function firstUrl(v: any): string {
  if (!v) return "";

  if (typeof v === "string" && /^https?:\/\//i.test(v)) {
    return v.replace(/&amp;/g, "&");
  }

  if (Array.isArray(v)) {
    for (const x of v) {
      const u = firstUrl(x);
      if (u) return u;
    }
  }

  if (typeof v === "object") {
    for (const key of ["url_list", "urlList", "url"]) {
      const u = firstUrl(v[key]);
      if (u) return u;
    }
  }

  return "";
}

function urlsFrom(v: any): string[] {
  const out: string[] = [];

  const walk = (x: any) => {
    if (!x) return;

    if (typeof x === "string" && /^https?:\/\//i.test(x)) {
      const url = x.replace(/&amp;/g, "&").replace("/playwm/", "/play/");
      if (!out.includes(url)) out.push(url);
      return;
    }

    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }

    if (typeof x === "object") {
      walk(x.url_list);
      walk(x.urlList);
      walk(x.url);
      walk(x.play_addr);
      walk(x.playAddr);
    }
  };

  walk(v);
  return out;
}

function normalize(item: any, awemeId: string) {
  const video = item.video || {};
  const author = item.author || {};
  const music = item.music || {};

  const variants: any[] = [];

  const bitrates = video.bit_rate || video.bitRate || [];

  if (Array.isArray(bitrates)) {
    for (const q of bitrates) {
      const urls = urlsFrom(q.play_addr || q.playAddr || q);
      const bitrate = Number(q.bit_rate || q.bitRate || q.bitrate || 0);
      const width = Number(q.width || video.width || 0);
      const height = Number(q.height || video.height || 0);

      for (const url of urls) {
        variants.push({
          url,
          bitrate,
          width,
          height,
          label: q.gear_name || q.gearName || "高清",
        });
      }
    }
  }

  if (!variants.length) {
    const urls = urlsFrom(video.play_addr || video.playAddr);

    for (const url of urls) {
      variants.push({
        url,
        bitrate: 0,
        width: Number(video.width || 0),
        height: Number(video.height || 0),
        label: "标准",
      });
    }
  }

  variants.sort(
    (a, b) =>
      b.bitrate - a.bitrate ||
      b.width * b.height - a.width * a.height
  );

  const imagesRaw =
    item.images ||
    item.image_post_info?.images ||
    item.imagePostInfo?.images ||
    [];

  const images: string[] = [];

  if (Array.isArray(imagesRaw)) {
    for (const img of imagesRaw) {
      const url = firstUrl(
        img.url_list ||
          img.urlList ||
          img.display_image ||
          img.displayImage ||
          img
      );

      if (url && !images.includes(url)) images.push(url);
    }
  }

  const cover =
    firstUrl(video.cover) ||
    firstUrl(video.origin_cover || video.originCover) ||
    images[0] ||
    "";

  const audio = firstUrl(music.play_url || music.playUrl);

  return {
    ok: true,
    platform: "抖音",
    awemeId,
    type: images.length ? "images" : "video",
    title: String(item.desc || "抖音作品"),
    author: String(author.nickname || ""),
    cover,
    videos: images.length ? [] : variants.slice(0, 8),
    images,
    audio: audio ? [audio] : [],
    strategy: "iesdouyin:_ROUTER_DATA",
  };
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed" },
      { status: 405 }
    );
  }

  try {
    const body = await req.json();
    const input = cleanInput(body?.url);

    if (!/^https?:\/\//i.test(input)) {
      return Response.json(
        { ok: false, error: "链接格式不正确" },
        { status: 400 }
      );
    }

    // 1. 先跟随抖音短链
    const resolved = await fetchPage(input);

    const finalUrl = resolved.url || input;

    // 2. 从最终 URL 或返回 HTML 提取作品 ID
    let awemeId =
      extractAwemeId(finalUrl) ||
      extractAwemeId(resolved.text) ||
      extractAwemeId(input);

    if (!awemeId) {
      return Response.json(
        {
          ok: false,
          error: "短链已打开，但没有提取到作品 ID",
          finalUrl,
        },
        { status: 422 }
      );
    }

    // 3. 使用移动端分享页
    const shareUrl =
      `https://www.iesdouyin.com/share/video/${awemeId}/`;

    const share = await fetchPage(shareUrl);

    if (!share.ok) {
      return Response.json(
        {
          ok: false,
          error: `抖音分享页返回 HTTP ${share.status}`,
          awemeId,
          shareUrl,
        },
        { status: 502 }
      );
    }

    // 4. 解析 window._ROUTER_DATA
    const router = extractRouterData(share.text);

    if (!router) {
      return Response.json(
        {
          ok: false,
          error: "页面已打开，但没有找到 window._ROUTER_DATA",
          awemeId,
          shareUrl,
          htmlLength: share.text.length,
        },
        { status: 502 }
      );
    }

    // 5. 找 videoInfoRes.item_list[0]
    const item = findVideoInfoRes(router);

    if (!item) {
      return Response.json(
        {
          ok: false,
          error: "_ROUTER_DATA 已找到，但没有找到 videoInfoRes.item_list",
          awemeId,
        },
        { status: 502 }
      );
    }

    return Response.json(normalize(item, awemeId));
  } catch (e: any) {
    return Response.json(
      {
        ok: false,
        error: e?.message || "抖音解析失败",
      },
      { status: 500 }
    );
  }
};

export const config: Config = {
  path: "/api/douyin-parse",
};
