const $ = s => document.querySelector(s);
const input = $('#url'), go = $('#go'), paste = $('#paste'), result = $('#result');
const names = { douyin: '抖音', tiktok: 'TikTok', instagram: 'Instagram', twitter: 'X / Twitter', xiaohongshu: '小红书' };
function status(text, bad = false) {
  const node = $('#status'); node.textContent = text; node.style.display = text ? 'block' : 'none'; node.className = 'status' + (bad ? ' bad' : '');
}
function errorText(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '请求超时，请稍后重试。';
  if (error instanceof TypeError) return '连接或媒体传输中断，请重新解析后重试；也可能受到浏览器跨域策略限制。';
  return error?.message || '请求失败，请稍后重试。';
}
function cleanUrl(text) {
  const raw = text.match(/https?:\/\/[^\s<>"'，。；！？、]+/i)?.[0];
  if (!raw) throw new Error('没有找到有效分享链接。');
  const u = new URL(raw.replace(/[)\]}>，。；！？、]+$/g, ''));
  const hosts = { douyin: ['douyin.com','iesdouyin.com'], tiktok: ['tiktok.com'], instagram: ['instagram.com'], twitter: ['x.com','twitter.com','t.co'], xiaohongshu: ['xiaohongshu.com','xhslink.com','xhslink.cn'] };
  const platform = Object.keys(hosts).find(p => hosts[p].some(h => u.hostname === h || u.hostname.endsWith('.' + h)));
  if (!platform || u.username || u.password || u.port) throw new Error('暂不支持该分享链接。');
  u.protocol = 'https:'; return { url: u.href, platform };
}
function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
}
function invalidApiResponse(response) {
  if (response.redirected) return '本站接口被重定向，可能需要重新登录预览站点后再解析。';
  if (response.status === 401 || response.status === 403) return '本站接口拒绝访问，请检查站点登录或访问权限。';
  if (response.status === 429) return '本站解析请求过于频繁，请稍后重试。';
  if (response.status >= 500) return `本站解析服务暂时不可用（HTTP ${response.status}），请稍后重试。`;
  return '本站接口没有返回有效数据，请检查部署路由或站点访问状态。';
}
function publicDebug(data) {
  return JSON.stringify(data, (key, value) => /url|token|signature|secret|authorization/i.test(key) ? (value ? '[已隐藏]' : value) : value, 2);
}
async function download(resource, button, errorNode) {
  button.disabled = true; button.textContent = '下载中…'; errorNode.textContent = '';
  try {
    const response = await fetch(resource.downloadUrl, { signal: AbortSignal.timeout(55000), cache: 'no-store' });
    const mime = response.headers.get('content-type') || '';
    if (!response.ok || /json|html|text\//i.test(mime)) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `下载失败（HTTP ${response.status}），请重新解析。`);
    }
    if (!/^(video|image|audio)\//i.test(mime)) throw new Error('响应不是可下载的媒体文件。');
    const blob = await response.blob();
    if (!blob.size) throw new Error('下载文件为空，请重新解析。');
    const objectUrl = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = objectUrl;
    const disposition = response.headers.get('content-disposition') || '';
    a.download = disposition.match(/filename="([a-z0-9_.-]+)"/i)?.[1] || `${resource.platform}-${resource.index}`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    status('文件已完整接收，已交给浏览器保存。');
  } catch (e) { errorNode.textContent = errorText(e); status('下载失败：' + errorText(e), true); }
  finally { button.disabled = false; button.textContent = '下载'; }
}
function mediaCard(resource, label, onMetadata = () => {}) {
  const card = element('div', 'media');
  const error = element('div', 'error', resource.error);
  const qualityNode = element('div', 'quality');
  const refreshQuality = () => {
    const details = [resource.type === 'audio' ? '音频' : resource.quality || '未提供分辨率'];
    if (resource.qualitySource === 'browser-preview') details.push('预览读取');
    if (resource.bitrate) details.push(`${Math.round(resource.bitrate / 1000)} kbps`);
    if (resource.bytes) details.push(resource.bytes < 1024 ? `${resource.bytes} B` : resource.bytes < 1024 * 1024 ? `${(resource.bytes / 1024).toFixed(1)} KiB` : `${(resource.bytes / 1024 / 1024).toFixed(1)} MiB`);
    if (resource.fallback) details.push('优先候选不可用，已验证备用版本');
    qualityNode.textContent = details.join(' · ');
  };
  refreshQuality();
  if (resource.previewUrl) {
    const tag = resource.type === 'image' ? 'img' : resource.type === 'audio' ? 'audio' : 'video';
    const preview = element(tag);
    if (tag === 'img') { preview.alt = label; preview.loading = 'lazy'; }
    else { preview.controls = true; preview.preload = 'metadata'; if (tag === 'video') preview.playsInline = true; }
    if (tag === 'video' || tag === 'img') preview.addEventListener(tag === 'video' ? 'loadedmetadata' : 'load', () => {
      if (!card.isConnected) return;
      const width = tag === 'video' ? preview.videoWidth : preview.naturalWidth;
      const height = tag === 'video' ? preview.videoHeight : preview.naturalHeight;
      if (width > 0 && height > 0 && (width !== resource.width || height !== resource.height)) {
        resource.width = width; resource.height = height; resource.quality = `${width}×${height}`;
        resource.availableQualities = [resource.quality]; resource.qualitySource = 'browser-preview';
        refreshQuality(); onMetadata();
      }
    });
    preview.src = resource.previewUrl;
    preview.addEventListener('error', () => { error.textContent = '预览不可用或链接已过期，请重新解析。'; });
    card.appendChild(preview);
  }
  const row = element('div', 'mrow'), text = element('div', 'mtext');
  text.appendChild(element('div', 'mname', label));
  text.appendChild(qualityNode); row.appendChild(text);
  if (resource.downloadUrl) {
    const actions = element('div', 'actions'), button = element('button', '', '下载');
    button.onclick = () => download(resource, button, error); actions.appendChild(button); row.appendChild(actions);
  }
  card.append(row, error); return card;
}
function render(data) {
  $('#title').textContent = data.title; $('#sub').textContent = `来源：${names[data.platform]}${data.author ? ' · ' + data.author : ''}`;
  $('#debug').textContent = publicDebug(data);
  const refreshDetails = () => { $('#debug').textContent = publicDebug(data); };
  for (const id of ['lives','videos','images','audios']) $('#' + id).replaceChildren();
  const counts = { lives: 0, videos: 0, images: 0, audios: 0 };
  for (const item of data.items) {
    if (item.type === 'live_photo') {
      const group = element('div', 'media'); group.appendChild(element('div','mname', `实况照片 ${item.index}`));
      if (item.image) group.appendChild(mediaCard(item.image, '静态图片', refreshDetails));
      if (item.motion) group.appendChild(mediaCard(item.motion, '动态视频', refreshDetails));
      if (item.error) group.appendChild(element('div','error',item.error));
      $('#lives').appendChild(group); counts.lives++;
    } else {
      const section = item.type === 'image' ? 'images' : item.type === 'audio' ? 'audios' : 'videos';
      const label = item.type === 'image' ? '图片' : item.type === 'audio' ? '音频' : item.type === 'unknown' ? '未确认资源' : '视频';
      $('#' + section).appendChild(mediaCard(item, `${label} ${item.index}`, refreshDetails)); counts[section]++;
    }
  }
  for (const [id, key] of [['ls','lives'],['vs','videos'],['is','images'],['as','audios']]) $('#' + id).style.display = counts[key] ? 'block' : 'none';
  const firstImage = data.items.find(i => i.type === 'image' && i.previewUrl)?.previewUrl || data.items.find(i => i.image?.previewUrl)?.image?.previewUrl;
  const cover = $('#cover'), coverUrl = data.previewUrl || firstImage;
  const head = cover.parentElement;
  head.classList.toggle('no-cover', !coverUrl);
  cover.style.display = coverUrl ? 'block' : 'none';
  if (coverUrl) { cover.src = coverUrl; cover.onerror = () => { cover.style.display = 'none'; head.classList.add('no-cover'); }; } else cover.removeAttribute('src');
  result.style.display = 'block';
  const count = data.items.reduce((sum, i) => sum + (i.downloadUrl ? 1 : 0) + (i.image?.downloadUrl ? 1 : 0) + (i.motion?.downloadUrl ? 1 : 0), 0);
  status(`${data.partial ? '部分资源可用' : '媒体校验完成'}：${count} 个资源可下载。${(data.warnings || []).join(' ')} ${data.verification || ''}`, data.partial);
}
async function parse() {
  if (go.disabled) return;
  try {
    const { url, platform } = cleanUrl(input.value.trim()); input.value = url;
    go.disabled = paste.disabled = true; result.style.display = 'none';
    status(`已识别：${names[platform]}，正在解析并校验媒体…`);
    const response = await fetch(platform === 'douyin' ? '/api/douyin-parse' : '/api/parse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(55000),
    });
    const data = await response.json().catch(() => { throw new Error(invalidApiResponse(response)); });
    if (!response.ok || !data.ok) throw new Error((data.error || `解析失败（HTTP ${response.status}）`) + (data.fallback ? ' 备用服务：' + data.fallback.error : ''));
    render(data);
  } catch (e) { result.style.display = 'none'; status('解析失败：' + errorText(e), true); }
  finally { go.disabled = paste.disabled = false; }
}
go.onclick = parse; input.onkeydown = e => { if (e.key === 'Enter') parse(); };
paste.onclick = async () => {
  try { input.value = await navigator.clipboard.readText(); } catch { status('无法读取剪贴板，请手动粘贴。', true); return; }
  await parse();
};
