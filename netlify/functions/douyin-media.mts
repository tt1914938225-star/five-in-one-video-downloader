import type { Config, Context } from "@netlify/functions";

function allowed(raw: string) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    const ok = [
      ".douyinvod.com", ".douyinpic.com", ".douyinstatic.com", ".snssdk.com",
      ".bytecdn.cn", ".bytedance.com", ".zjcdn.com"
    ].some(s => h.endsWith(s)) || ["aweme.snssdk.com"].includes(h);
    return ok ? u : null;
  } catch { return null; }
}

export default async (req: Request, context: Context) => {
  const requestUrl = new URL(req.url);
  const target = allowed(requestUrl.searchParams.get("url") || "");
  if (!target) return new Response("Invalid media URL", { status:400 });

  const headers = new Headers({
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1",
    "Referer": "https://www.douyin.com/",
    "Accept": "video/mp4,video/*;q=0.9,image/avif,image/webp,image/*,*/*;q=0.7",
  });
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  const upstream = await fetch(target.toString(), { headers, redirect:"follow" });
  if (!upstream.ok && upstream.status !== 206) return new Response(`Upstream ${upstream.status}`, { status:upstream.status });

  const out = new Headers();
  for (const k of ["content-type","content-length","content-range","accept-ranges","etag","last-modified"]) {
    const v = upstream.headers.get(k); if (v) out.set(k,v);
  }
  out.set("Cache-Control", "private, max-age=180");
  return new Response(upstream.body, { status:upstream.status, headers:out });
};

export const config: Config = { path: "/api/douyin-media" };
