import type { Config, Context } from "@netlify/functions";

function allowedMediaUrl(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "video.twimg.com" ? u : null;
  } catch {
    return null;
  }
}

export default async (req: Request, context: Context) => {
  const requestUrl = new URL(req.url);
  const raw = requestUrl.searchParams.get("url") || "";
  const target = allowedMediaUrl(raw);

  if (!target) {
    return new Response("Invalid or unsupported media URL", { status: 400 });
  }

  const headers = new Headers({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
    "Referer": "https://x.com/",
    "Accept": "video/avc,video/mp4,video/*;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  });

  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  const upstream = await fetch(target.toString(), {
    method: "GET",
    headers,
    redirect: "follow"
  });

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`X media upstream returned ${upstream.status}`, {
      status: upstream.status
    });
  }

  const responseHeaders = new Headers();
  for (const key of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified"
  ]) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }

  responseHeaders.set("Content-Disposition", 'inline; filename="x-video.mp4"');
  responseHeaders.set("Cache-Control", "private, max-age=300");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
};

export const config: Config = {
  path: "/api/x-media"
};
