# V2 Beta 检查、修复与验收说明

检查日期：2026-10-27（Asia/Shanghai）。基线：`main` 的 `97aef28`。本地初始目录为空，克隆仓库后检查原工作区干净，再建立 `fix/v2-beta-media-pipeline` 分支。

后续已通过 Chrome 登录继续运行时验收，并补充修复。最新用户样本、117 项测试及增量修复见 [2026-10-28 验收记录](ACCEPTANCE-2026-10-28.md)；前一日配置与实测见 [Preview 续验记录](ACCEPTANCE-2026-10-27.md)。下文保留初次检查的时间点和部署方法。

## 一、原有结构和问题证据

仓库原有六个文件：`index.html`、`package.json`、`netlify.toml` 和三个 Functions（`douyin-parse.mts`、`douyin-media.mts`、`x-media.mts`）。无锁文件、自动化测试或独立平台适配器。

原数据流：浏览器加载 CDN 上的 `btch-downloader@6.3.6`；抖音先调用本站 Function，失败后与其他平台一样直接请求第三方服务；浏览器递归搜索 URL、按字段路径和文件名评分，选择媒体。下载主要通过带 `target=_blank` 的链接，只有部分源站地址走代理。

1. 抖音自动 `redirect: follow` 会丢失中间 URL。未检查短链最终 HTTP 状态，最终落首页也统一报告作品 ID 缺失。
2. 抖音只取 `item_list[0]`，将同一视频的清晰度当多段资源；图文出现后丢弃视频分支；修改 `/playwm/` 字符串生成未经验证的地址。本次不再改写源站媒体路径。
3. 前端递归搜索会把缩略图、头像或背景音乐混入资源。通用 X HD/SD 合并会丢弃备用版本，多个视频也可能被误合并。
4. 虽然当前主流程不调用自动实况配对，但旧代码仍保留按数组索引、文件名配对的启发式函数。本次去除该路径，只消费明确的结构化关系。
5. 两个代理只校验初始域名，随后自动跟随任意重定向；没有超时、DNS 私网检查和媒体文件头检查，可能转发 HTML 错误页。
6. `publish = "."` 把后端目录纳入静态站点。检查时，线上 `/netlify/functions/douyin-parse.mts` 返回 HTTP 200 和源码类型 `model/vnd.mts`，长度 7933。新构建只发布 `dist`。
7. `/api/...` 使用 Function `config.path` 注册，原 `netlify.toml` 没有重写规则；未发现 API 被 SPA 回退覆盖。新版本继续单一 `config.path` 路由，不添加重复重写。

### 抖音给定短链的结论

`https://v.douyin.com/XHfZJuHadiE/` 在本次 curl 请求中直接返回 HTTP 302，Location 为 `https://www.douyin.com`。使用移动端 UA 跟随后得到首页 HTTP 200；线上 `/api/douyin-parse` 也复现用户提供的失败 JSON。

**这证明当前请求路径无法取得作品 ID，不能单凭首页跳转认定原链接无效，也不能证明一定是反爬。** 失效链接、访问上下文限制和平台策略都可能导致首页跳转。新版报告 `SHORTLINK_HOME`，建议重新从官方分享菜单复制或提供长链接。

如果作品 ID 出现在中间重定向，新版会保留它；如果公开分享页提供数据，解析 `_ROUTER_DATA`、URL 编码的 `RENDER_DATA` 或 JSON `__NEXT_DATA__`。不执行页面脚本，不从首页推荐列表里猜作品 ID。

具体区分：404/410 或明确删除提示 → `NOT_FOUND`；明确验证页面 → `PLATFORM_RESTRICTED`；首页无 ID → `SHORTLINK_HOME`；重定向缺失、循环、超限 → 对应重定向错误；有页面无公开数据 → `PAGE_DATA_MISSING`；有数据无对应作品 → `WORK_DATA_MISSING`。这些类别不声称能够识别所有平台隐藏策略。

### X“未经授权”的结论

没有收到当时实际失败的媒体地址和发布时间，无法确认是源站授权、第三方临时签名过期还是传输问题。新版保留原 URL 和完整查询参数，不解码再拼接签名；完整 GET 探测同一资源，拒绝 401/403；仅当备用版本也通过验证才回退。新界面不会用 `window.open()` 代替下载验证。

## 二、修改文件与作用

| 文件 | 作用 |
|---|---|
| `index.html` | 保留深色样式、响应式网格、媒体分区、预览和详情；改加载本地脚本、增加可访问标签和大小限制说明 |
| `app.js` | 同源解析、统一卡片、明确实况分组、部分失败卡片、完整 Blob 下载、错误提示、详情脱敏 |
| `netlify/functions/douyin-parse.mts` | 保留抖音兼容路由，调用共享解析链 |
| `netlify/functions/parse.mts` | 新增五平台统一解析入口和平台速率限制 |
| `netlify/functions/media.mts` | 新增统一加密凭证媒体入口和速率限制 |
| `netlify/functions/douyin-media.mts`、`x-media.mts` | 兼容旧路由，统一要求有效凭证，不再接受任意 URL 代理 |
| `server/config.mts` | 平台域名、第三方服务、媒体允许域名和限制集中配置 |
| `server/network.mts` | HTTPS/域名/逐跳校验、连接时 DNS 地址校验与固定、超时、限量读取 |
| `server/douyin.mts` | 保留中间 ID、公开分享页 JSON 数据提取、精确错误分类 |
| `server/model.mts` | `Parsed`、`MediaItem`、`Variant` 类型及质量排序 |
| `server/adapters.mts` | 各平台已知返回结构的显式适配；保留图片/视频列表；实况要求明确元数据 |
| `server/provider.mts` | 服务端第三方调用、公开 SDK 的已有 GET 协议及可选独立 POST 协议 |
| `server/media.mts` | 状态/响应头/文件头/大小验证，候选回退，HEAD/Range/下载再次检查 |
| `server/tokens.mts` | AES-256-GCM 加密并认证下载凭证，默认有效十分钟 |
| `server/parse.mts`、`server/errors.mts` | 共享处理、限时、备用失败保留、稳定且脱敏的错误响应 |
| `netlify.toml`、`scripts/build.mjs` | 静态发布白名单、Node 24、测试构建门槛、安全响应头 |
| `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.json` | 可重复安装、类型检查、测试、构建与打包命令；仅新增 undici 作为运行依赖，用于安全 DNS 连接 |
| `scripts/dev.mjs`、`scripts/verify-bundle.mjs` | 本地开发服务器、五个 Function 入口打包验证 |
| `tests/*.mts` | 平台独立测试入口、共享模拟响应和重点回归测试 |
| `.github/workflows/check.yml` | PR / 非生产分支自动执行安装、检查、测试、构建及打包检查 |
| `.gitignore`、`.env.example` | 忽略密钥、依赖、构建目录及 Netlify 状态；列出运行配置 |
| `README.md`、本文件 | 本地运行、协议、限制、验收和发布说明 |

## 三、统一结构与分类边界

服务内部每个项目包含 `id/index/type/title/platform/preview/variants`。每个候选保留原始 `url`、已知 `width/height/bitrate/label`。实况项目用 `image` 与 `motion` 两个子资源关联，不按名字或数组索引猜测。

返回浏览器的资源包含媒体类型、序号、标题、平台、实际已知尺寸/码率、加密 `previewUrl/downloadUrl`、`expiresAt` 和错误。原始地址保留在加密票据中，不出现在详情面板。`availableQualities` 只表示本次验证并选中的版本，不把未检查的候选宣称为可用。

抖音优先公开分享数据；Instagram 使用每条作品媒体 URL，不将 thumbnail 计为媒体；X 支持已给出的双 singleton HD/SD 结构、每段各自的 HD/SD 对和 `extended_entities.media`；TikTok 保留显式媒体数组；小红书保留 `images/imageList`、视频 stream 和 `downloads`。

SDK 的小红书 `downloads` 类型定义未保证媒体类型，因此以响应 MIME 和文件头确认。明确的实况标记必须出现在同一图片条目或版本化协议中，并提供两个资源；普通视频 + 封面不会成为实况。未标明关联的动态资源单独列为视频。

如果同一视频的不同清晰度被上游作为无 ID、无分组的数组元素返回，就无法可靠判断它们是清晰度还是多段视频；本版保留每项，避免吞掉作品。要消除此歧义，应由独立适配器提供下文的 `items[].variants`。

只返回 `application/octet-stream` 时，图片可通过文件签名确认；视频/音频容器需要显式类型元数据，未知 ISO 容器不会根据 `.mp4` 后缀猜测。m3u8/DASH、SVG 和未知格式不转为假 MP4。

## 四、环境变量

在 Netlify 项目环境变量中设置，作用域必须包含 **Functions**；Preview 与生产分别配置，修改后重新部署。不要把运行密钥写入 `netlify.toml` 或前端。

| 变量 | 必须 | 说明 |
|---|---|---|
| `MEDIA_TOKEN_SECRET` | 是 | 至少 32 字节随机密钥，用于加密下载凭证；缺失时明确返回配置错误 |
| `PARSER_BASE_URL` | 否 | 默认 `https://backend1.tioo.eu.org`；使用原 SDK 已有端点协议，不保证服务可用 |
| `PARSER_ADAPTER_URL` | 否 | 独立适配器完整 HTTPS 地址；配置后覆盖默认第三方 GET 协议 |
| `PARSER_API_KEY` | 否 | 如受控解析服务要求，作为 Bearer 凭证仅在后端发送；默认公开服务没有硬编码密钥 |
| `MEDIA_ALLOWED_HOSTS` | 否 | 人工审核后的精确媒体/重定向域名，逗号分隔；不支持任意通配符 |

可在自己电脑生成随机密钥后填入 Netlify 的密钥字段，例如 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。不要将输出粘贴到聊天、PR 或源码中。测试目录里的固定值仅用于离线测试。

默认允许各平台常见媒体 CDN，以及配置的原解析服务主机。未知 CDN 不会自动放行，应核实域名归属后加入精确列表。每次重定向重新校验域名、HTTPS 和端口；连接时拒绝私网、元数据、保留、文档和 IPv4 映射地址，避免 DNS 重绑定。不会继承浏览器 Cookie 或客户端 Authorization。

## 五、可选独立解析后端（未部署、不要求 VPS）

适用情形：Netlify 出口 IP 被限制、公开页面必须在合规授权环境下获取、服务协议需要转换，或当前第三方服务不可用。可使用已有合规解析服务、自有按需服务或其他 serverless 服务；需要长期主机的方案应先由项目所有者确认。

设置 `PARSER_ADAPTER_URL=https://your-approved-service.example/parse` 后，本站发送：

```http
POST /parse
Content-Type: application/json
Authorization: Bearer <PARSER_API_KEY，如配置>

{"schemaVersion":1,"platform":"xiaohongshu","url":"https://...公开分享链接..."}
```

成功响应为本项目新增、明确版本的协议，不假称默认服务支持：

```json
{
  "schemaVersion": 1,
  "title": "示例作品",
  "thumbnail": "https://approved-cdn.example/cover.jpg",
  "items": [
    {"type":"video","variants":[
      {"url":"https://approved-cdn.example/video-hd.mp4","width":1280,"height":720,"bitrate":2000000},
      {"url":"https://approved-cdn.example/video-sd.mp4","width":640,"height":360}
    ]},
    {"type":"image","variants":[{"url":"https://approved-cdn.example/image.jpg"}]},
    {"type":"live_photo",
     "image":{"variants":[{"url":"https://approved-cdn.example/still.jpg"}]},
     "motion":{"variants":[{"url":"https://approved-cdn.example/motion.mp4"}]}}
  ]
}
```

错误响应使用非 2xx 或 `{"ok":false}`。不要返回 Cookie、登录凭证、内部调试错误或伪造的原画尺寸。本站仍验证每个资源和媒体域名，独立后端不会自动绕过校验。上例 CDN 是协议占位符，部署前须换成真实合法资源和允许域名。

独立**解析**后端不能消除 Netlify **下载**转发上限。若要支持大文件，应另行设计经确认的下载服务：限定来源、短时凭证、限额与超时、明确的下载结果，必要时提供经过授权的 CORS。该服务及客户端集成未在本次创建；当前超限明确拒绝，不偷偷重定向、不静默开新窗口。

## 六、可重复测试与本次结果

离线测试使用模拟 JSON、重定向和媒体文件头，不依赖真实平台稳定可访问。每个平台有独立 `.test.mts` 入口；公共协议测试不会被当作该平台官方支持所有媒体类型的证据。

| 覆盖项 | 抖音 | TikTok | Instagram | X | 小红书 |
|---|---|---|---|---|---|
| 分享/短链接传递及查询参数保留 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 普通视频 + 完整下载 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 多段视频 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 单图 / 多图 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 显式实况关联协议 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 无效链接 / 过期 / 无权访问 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 第三方故障 / 只有封面 / HTML 假媒体 | 通过 | 通过 | 通过 | 通过 | 通过 |

重点回归另覆盖：抖音中间 ID 与首页跳转、验证/删除/数据缺失、推荐列表误识别；X HD 拒绝后 SD 验证、双版本都失败、多段结构；小红书普通视频不误判实况、全部图片、替代图片 URL、部分失败；下载凭证过期/篡改、HEAD/Range、完整 GET 遭撤权、体积限制、未知体积、二进制 MIME、部分响应、SSRF 地址和重定向、独立适配器及源代码静态发布隔离。

本次本地检查：类型与前端语法检查通过；自动测试 96 项通过、0 项失败；构建通过；5 个 Function 入口 esbuild 打包通过。浏览器模拟响应检查通过：三项图集顺序、两项可下载、一项 403 无按钮、详情脱敏、文件完整接收后保存。GitHub CI 和首个 Netlify Preview 构建也已通过。手机尺寸、真实视频解码和 Netlify CDN/Functions 集成仍待登录后验收。

模拟 MP4/JPEG 数据用于协议和文件头测试，不是源站下载样本或完整音视频解码测试。公共实况测试主要验证版本化协议，真实源站能否返回实况标记必须手动验证。

### 真实网络检查的限制

- 线上抖音错误及首页 302 已通过 curl 复现。
- 原第三方服务本次请求超时，无法确认其目前解析成功率。
- 本机 Node 的社交域名 DNS 解析得到保留地址，安全策略按设计拒绝；没有为完成测试放松私网保护。此环境中的 Node 请求不能代替 Netlify 实测。
- Netlify 管理插件要求重新认证，无法读取或修改环境变量；但 PR 已触发仓库现有的自动部署，Netlify bot 确认 [Preview 已就绪](https://deploy-preview-1--five-in-one-video-downloader.netlify.app)，[构建记录](https://app.netlify.com/projects/five-in-one-video-downloader/deploys/6ae06aae86e512f339ab6f42) 显示构建完成。公开 HTTP 请求到首页、API 和源码测试路径均被 Netlify 登录页的 HTTP 401 拦截；浏览器明确显示“Team protection / This site is private / Sign in with an invited Netlify account to view it”。因此不能把这些 401 当作应用 API 或源码隔离的运行时验收结果。本次没有修改访问保护、合并 PR 或运行生产部署。
- 没有当时失败的 X 签名 URL，无法断言此前“未经授权”的唯一原因。

## 七、Preview 验收与生产发布

1. 将修复分支对应的草稿 PR 保持为未合并；重新连接 Netlify 账号，确认站点仍关联本仓库的 `main`，且 PR Deploy Previews 已启用。分支推送是否触发构建取决于站点配置，不能仅凭 PR 地址认定 Preview 就绪。
2. 在 deploy-preview 上下文设置 `MEDIA_TOKEN_SECRET`（Functions 作用域），如有需要再设置解析服务地址和允许的 CDN 主机。不要直接改生产环境变量。
3. 从 [PR #1](https://github.com/tt1914938225-star/five-in-one-video-downloader/pull/1) 的 Netlify bot 链接打开真实 Preview；当前团队保护要求受邀 Netlify 账号登录。登录后再运行以下检查，不需要关闭站点访问保护；更新提交后确认对应最新构建成功。
4. 检查首页和本地脚本加载；分别调用 `/api/parse`、`/api/douyin-parse`；`/netlify/functions/douyin-parse.mts`、`/server/config.mts`、`/tests/fixtures.mts` 应不可作为静态源码访问。
5. 每个平台准备自己有权保存的公开链接。至少有一个有效分享链接/短链接和普通视频；支持图集的平台还测单图、多图；有真实实况元数据的平台测两资源配对。多段视频逐项核对源站数量。对于不存在的类型，记录“不适用”，不要用模拟结果证明真实平台能力。
6. 抖音：重试给定短链并记录错误码；另提供刚复制的新短链和含作品 ID 的长链。如果原短链继续跳首页，应保留明确失败，不宣称已恢复此链接。
7. X：提供新解析得到的公开资源，确认实际尺寸；在 Network 中核对高清是否拒绝、低清是否独立验证、完整下载是否 200 且可播放。不得将旧签名 URL 直接复制为长期测试样本。
8. 小红书：核对所有原图数量、加载情况、封面；普通视频不出现在实况区；真实实况同时可下载静态和动态资源。
9. 测试 401/403/404、错误页、超时、十分钟凭证到期、超 18 MiB、媒体被撤权；确认失败有提示且没有成功按钮。手机 Safari/Android Chrome 检查一列布局、预览、保存行为与浏览器支持格式。
10. 真实媒体下载后应核对文件大小、实际可播放性和清晰度。通过头部探测不等于完整解码成功；验收失败应继续修复并重新跑回归。
11. 用户确认 Preview 和真实链接结果后，配置生产 Functions 的同名变量，确认无密钥进入前端/源码，再合并 PR 到生产分支，由现有 Git 持续部署发布。检查正式站解析、下载和源码不可见性。**本次不自动合并、不运行 `netlify deploy --prod`。**

## 参考依据

- [原项目仓库](https://github.com/tt1914938225-star/five-in-one-video-downloader)
- [btch-downloader 源码仓库](https://github.com/hostinger-bot/btch-downloader)；本次额外核对已使用版本的 [浏览器源码](https://cdn.jsdelivr.net/npm/btch-downloader@6.3.6/dist/browser/index.js) 和 [类型定义](https://cdn.jsdelivr.net/npm/btch-downloader@6.3.6/dist/Types/types.d.ts)，端点来自现有实现而非猜测。
- [Netlify Functions API：流式响应](https://docs.netlify.com/build/functions/api/#streaming-responses)：返回 ReadableStream；文档载明 60 秒及 20 MB 上限，本项目采用保守的 18 MiB 上限。
- [Netlify Deploy Previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/)
