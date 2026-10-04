# zoetrope（西洋镜）— 多平台单页多视图

> 项目名 `zoetrope` / 中文 **西洋镜**：一个箱子里装着好几幅画，一次只看得到一幅，靠转动切换 ——
> 正是本项目的行为特征（多平台同处一页、焦点决定可见区域、非焦点降档而非断开）。
>
> 状态：设计草案 **v0.3**
> v0.1 → v0.2：新增 §2「同步 DOM」可行性分析；远程渲染降级为条件性方案
> v0.2 → v0.3：**用户确认"客户端不装任何东西，必须纯网页打开就用"** → 原生多视图（§3）与
> 扩展+iframe（§11）双双出局；新增 **§14 路径 B 拦截代理**（让用户的浏览器自己渲染），
> 它是当前唯一可能"便宜地"满足该约束的路线

---

## 0. 先读这一节：两条路，先跑便宜的那条

**用户已确认（2026-10-02）：客户端不装任何东西，必须"纯网页打开就用"。**
这条约束同时排除了：

- §3 的原生多视图（要装 Electron / 原生 App）
- §11 的扩展 + iframe（扩展本身也是安装）

于是只剩下两条路。**关键区别是"谁来渲染"**：

| | **路径 B：拦截代理**（§14 — 已建好并通过 M0 验证） | **路径 A：远程渲染**（§6） |
|---|---|---|
| 谁渲染 | **用户自己的浏览器**（原生渲染） | 服务端浏览器，画面推给客户端 |
| 服务端要做什么 | 一个 HTTP 反代 + URL 重写 | 跑真浏览器 + 采集 + 编码 + 输入注入 |
| 输入法 | ✅ 原生，零延迟 | ⚠️ 要自己做（§10） |
| 音频 | ✅ 原生 | ⚠️ 要单独做（§9） |
| 视频解码 | ✅ 客户端硬件解码 | ⚠️ 服务端重编码 + 客户端硬解（§8） |
| 平台自身多标签页 | ✅ 天然完整 | ⚠️ 必须窗口级采集才保得住 |
| 保真度 | ⚠️ **取决于重写规则，可能碎** | ✅ 100% 保真，任何网站都能跑 |
| 风控 | ✅ 客户端真浏览器 + 办公室真实 IP | ✅ 但要自建 Windows 采集代理 |
| 成本 | **1–2 天可验证** | 数周 |
| 成熟开源实现 | ✅ Scramjet / Rammerhead | ✅ neko（仅 Linux） |

**路径 B 的成败只能靠实测，不能靠推演。** 目标平台的数量是有限的，逐个测一遍就有硬数据。
详见 §14 及其中给出的 1–2 天验证方案。

如果路径 B 在关键平台上失败，再回到路径 A（§6）——那时你已经知道为什么不得不付那笔钱。

---

## 1. 已确认的需求与决策

来自用户 2026-10-02 的答复：

| # | 需求 | 确认结果 |
|---|---|---|
| R1 | 传输层 | **WebRTC**，否决 noVNC |
| R2 | 为什么跑在别处 | 办公室服务器部署，**所有设备都能用**；保留观看进度、布局、已打开的社媒内容 |
| R3 | 风控规避 | **指定一台真实 Windows 机器**作为浏览器宿主，代码只做转发 |
| R4 | 硬解码 | 希望把社媒视频流转到用户机器上解码 |
| R5 | 焦点策略 | 焦点视图 = 远端激活 tab；非焦点视图 = 远端非激活 tab 但保持 WebRTC 传输；完全不在视窗内才停流 |
| R6 | 网络 | **大部分在局域网内** |
| R7 | 音频 | 需要 |
| R8 | 账号 | 登录真实账号，用户本人操作，**不需要独立出口 IP** |
| R9 | 输入法 | 需要中文输入法，倾向"直接透传" |
| R10 | 体验目标 | 操作与输入体验**和本地一样** |
| R11 | 平台特性 | 某些平台会占用多个标签页（→ 视图单元必须是**窗口级**） |

### 1.1 一个必须知道的冲突（如果走远程渲染）

**R3 与 neko 不可兼得。** neko 的采集管线基于 `ximagesrc`（X11），运行在 Debian 容器里
（[采集配置](https://neko.m1k1o.net/docs/v3/configuration/capture)、[FAQ](https://neko.m1k1o.net/docs/v3/faq)）。

- 要 neko → 浏览器是 **Linux Chrome in Docker**，正是你想躲开的风控环境。
- 要真实 Windows Chrome → **没有现成的 neko**，需自建 Windows 采集/注入代理。

**在 §3 的原生路径下，这个冲突根本不存在**——浏览器就跑在用户自己的机器上，是真 Chrome、真 Windows、真账号。

---

## 2. 专题："同步远端 DOM 树到本地渲染"到底行不行

用户的提问（2026-10-02）：*难道就不能通过实时同步远端浏览器中的实际 DOM 树来实现本地查看远端网页吗？*

**能，而且是真实产品化的架构。** 但它解决的不是你以为它解决的问题。先把"同步 DOM"拆成三种：

| 层次 | 做法 | 天花板 |
|---|---|---|
| **S1 快照** | CDP `Page.captureSnapshot` 拿到 MHTML / `DOMSnapshot`，本地渲染 | 静态。一次一份，页面一动就废。只能"看" |
| **S2 差分镜像** | 监听 DOM mutation，把变更下发，本地浏览器渲染 | **Menlo Security ACR 就是这个**，见下 |
| **S3 全保真镜像** | 脚本仍在远端执行，客户端负责渲染 + 把交互事件回传 | 你要的社媒场景。没有任何开源实现；Menlo 的核心 IP 也不是这一档 |

### 2.1 S2 是真的能work，而且体验优于像素流

Menlo Security 的 **Adaptive Clientless Rendering (ACR)** 用的就是 "**DOM Mirroring**"：
云端容器执行内容，把 DOM 树下发到用户**本机原生浏览器**渲染，滚动和动画由本地 GPU 跑。
它宣称相比第一代像素流 RBI：无延迟、无"粘连感"，且 find-in-page、打印、复制粘贴都能用
（[Menlo 官方博客](https://www.menlosecurity.com/blog/considerations-on-closing-the-browser-security-gap-part-5-doing-rbi-right)）。

所以你的直觉是对的：**这条路在技术上成立，而且在 UI 手感上确实比像素流更好。**
矢量文字清晰、滚动丝滑、浏览器原生能力全在。

### 2.2 但它成立的前提，恰恰是砍掉你需要的交互性

Menlo 原文："filters out active content (like `<script>` tags or `onclick` attributes) and sends only the benign, safe DOM tree"。

也就是说，**S2 镜像的是"安全渲染版"，不是"能用的网页"**。它剥离了脚本——而社媒平台的点赞、发帖、聊天、滚动加载全靠脚本。
对 Menlo 来说这无所谓（它的目标是**隔离**，不是让你正常用）；对你的目标是致命的。

### 2.3 要升到 S3（全保真），有四道跨不过去的坎

1. **非 DOM 表面无法镜像。** `<canvas>` / WebGL / 视频是 JS 算出来的像素缓冲区，**没有可镜像的 DOM 结构**。必须回退成像素或原始媒体流。而社媒平台的核心内容恰恰大量是这些。
2. **资源归属。** 客户端要加载 CSS / 字体 / 图片 / 视频。两条路：让客户端直连源站（那就带着用户真实 IP 直连平台——对你 R8 其实**可以接受**）；或全部 URL 改写走你的代理（于是撞上 CSP、CORS、**SRI 子资源完整性哈希**、Service Worker、WebSocket、流式响应，工作量不可控且极易碎）。
3. **镜像不完整的部分。** 跨域 iframe、closed Shadow DOM、`<input>` 光标/选区、`:hover`/`:focus` 伪类、滚动位置、contenteditable 状态，全都要额外注入探针逐个上报。CSP 严格的站点需要走 CDP `Page.addScriptToEvaluateOnNewDocument` 才能在文档创建前注入。
4. **事件回环。** 每次点击/按键都要：回传 → 远端 JS 执行 → DOM 变更 → 下发 → 渲染。LAN 下约 20–50ms 额外延迟，**这一条其实可以接受**；真正贵的是前面三条。

**结论：S3 是一个多人年量级、没有开源先例、且注定在某些页面上做不到全保真的项目。**

### 2.4 但最致命的问题不是难度 —— 是它没解决你的阻塞点

你撞的墙从来不是"像素 vs DOM"，而是：

> **我的页面不被允许加载并渲染它的文档。**

DOM 镜像做的事，本质上**恰恰就是"让我的页面加载并渲染它的文档"**——只是绕了最大的一圈。
你依然要拿到对方的资源、依然要让本地浏览器渲染对方的标记。

**而如果你确实能拿到资源并让本地浏览器渲染——那你根本不需要镜像 DOM。**
只要让平台页面作为**顶层文档**跑在一个你能控制的容器里，X-Frame-Options 和 CSP `frame-ancestors` 就**不适用于它**（它们只约束嵌套浏览上下文/iframe）。
这就是 §3。

---

## 3. 推荐路径：原生多视图（先做这个）

### 3.1 桌面：Electron / Tauri

- Electron 30+：一个窗口内挂 N 个 **`WebContentsView`**（旧的 `<webview>` 标签或 BrowserView 也行）。
- 每个平台一个视图，各自绑定独立的 `session.fromPartition('persist:平台名')` —— **登录态天然隔离且是第一方 cookie**。
- 焦点切换：`view.setVisible(true/false)` + `webContents.focus()`。隐藏的 view 会被 Chromium 自动节流，正好是 R5 想要的效果。
- **每个 view 是顶层导航**，所以 X-Frame-Options / CSP frame-ancestors 完全不适用。

**这条路白送的东西（也就是在 v0.1 里要花数周解决的东西）：**

| v0.1 的难题 | 原生路径下 |
|---|---|
| 风控指纹 | 真 Chrome / 真 Windows / 真用户，**没有这个问题** |
| 中文输入法 | 原生，候选框在本地，零延迟 |
| 音频 | 原生，自动按视图路由 |
| 视频硬解码 | 原生，`<video>` 直接走系统硬解 |
| 鼠标键盘映射 | 不需要，就是本地鼠标键盘 |
| 滚动丝滑度 | 原生 |
| find-in-page / 打印 / 剪贴板 / 拖拽 / DevTools | 原生全部可用 |
| 服务端成本 | 0（除了半天的小同步服务） |

**同一个问题的成熟解法就在你手边**：`anywhere-labs/dsh-desktop` 的侧边栏浏览器已经做过完全相同的迁移 ——
"[feat(next): use native pages in the sidebar browser](https://github.com/anywhere-labs/dsh-desktop/pull/1088)"，
把 iframe 换成 native pages。原因正是同一堵墙。**先去看那个 PR 的实现，能省掉大量试错。**

### 3.2 移动端：iOS / Android

- iOS：一个 App 里放 N 个 `WKWebView`；Android：N 个 `WebView`。
- 每个 webview 里的加载同样是**顶层浏览上下文**，X-Frame-Options 同样不适用。
- 各自天然拥有独立的第一方 cookie 存储。

### 3.3 跨设备同步（满足 R2）

R2 里"保留观看进度、布局、打开了的社媒内容"三件事，**只有第三件涉及会话，且不需要像素流**：

- **布局**：一个 JSON 文档，存服务端。
- **已打开的内容**：每个平台的标签页 URL 清单，存服务端；新设备按清单恢复。
- **观看进度**：平台自己记（靠登录态）；或控制面记 `(平台, 内容ID, 时间戳)`。
- 同步服务大约半天工作量，不需要 96 核服务器，也不需要 TURN。

---

## 4. 关于"实时同步 DOM"的最终判定

- **S1 快照**：可以做，但只在"只读、静态"场景有意义。
- **S2 差分镜像**：技术上最优的远程渲染形态，但要么剥掉脚本（→ 社媒不可用），要么升到 S3。
- **S3 全保真**：四道坎 + 无开源先例，且**绕一圈回到同一堵墙前面**。
- **还有第三条理论路线**（顺便记录）：不下发像素而是序列化**渲染指令**（Skia display list / 绘制算子列表），
  得到矢量清晰度 + 极低带宽，文字和 UI 的部分近乎完美。但 canvas / WebGL / 视频仍然只能回退成像素，
  而且**没有任何现成实现**。属于研究课题，不是工程选项。

---

## 5. 什么时候真的需要远程渲染

只有以下场景，且只有这些：

1. **客户端不能装东西**（公司电脑、他人设备、借用设备、只给一个 URL）。
2. **电视/机顶盒/车机**这类只有浏览器的设备。
3. **需要"同一实时会话"跨设备**（手机上看到的和你桌面上正在开的是同一个浏览器，含已登录状态与实时滚动位置）。
4. **需要浏览器 24 小时在线，且你的设备关机**（保活、定时任务）。
5. **设备是 iOS 但你不写原生 App** —— 那就只剩浏览器里跑一个像素流页面这一条路。

如果以上都不成立，**不要做远程渲染**。v0.1 的全套方案（Windows 采集代理、WebRTC、
GStreamer 按窗口采集、按进程音频、输入注入、三档焦点调度）仅在场景 1–5 成立时才需要，
且其中 §6–§8 的技术细节依然有效。

---

## 6. 远程渲染路径（仅在 §5 的条件成立时）

### 6.1 三种可选拓扑

| 拓扑 | 浏览器宿主 | 采集/传输 | 风控 | 输入法 | 音频 | 工作量 |
|---|---|---|---|---|---|---|
| **L：neko** | Docker 内 Linux Chrome | 现成，GStreamer + WebRTC | ⚠️ 差 | ⚠️ 官方只推荐装 Google Input Tools 扩展（已下架） | ✅ 每容器独立 PulseAudio | 1–3 天出原型 |
| **W：Windows 原生代理** | 真实 Windows + 真实 Chrome | 自建，GStreamer → webrtcbin | ✅ 最好 | ⚠️ 需自己做 | ⚠️ v1 走系统 loopback；按进程隔离有坑 | 数周 |
| **R：Windows + RDP/Guacamole** | Windows（多会话需 Server SKU） | Guacamole（WebSocket，非 WebRTC） | ✅ 好 | ✅ 客户端侧 IME 做得最正 | ✅ 每会话独立 | 中等 |

### 6.2 neko 详解（开源，Apache 2.0）

- **架构**：容器内 Xorg 虚拟显示 + 真浏览器（Firefox/Waterfox/Tor/Chrome/Edge/Brave/Vivaldi/Opera，另有 VLC/Remmina/KDE/Xfce 镜像）+ **PulseAudio**（音频在容器内，天然按实例隔离）+ GStreamer 管线。服务端 Go + Pion WebRTC 管信令与房间；客户端 Vue/TS，可自行 build 后挂到容器 `/var/www`。
- **采集**：视频源 `ximagesrc`；编码器可插拔（`vp8enc`/`vp9enc`/`av1enc`/`x264enc`/`x265enc`，或 `vah264enc`/`nvautogpuh264enc` 硬编）；音频 `pulsesrc` → `opusenc`；传输 `webrtcbin`。**整条管线可用 `gst_pipeline` 自定义**，且可定义多条不同码率/帧率的 pipeline（`hq`/`lq`）让客户端选，**这正好是 §7 焦点降档的现成机制**。
- **生命周期**：采集管线在首个客户端请求时启动、最后一个断开时停止 —— 正好是"按需喂流"。
- **嵌入 web app 的确切做法**（[官方 UI 文档](https://neko.m1k1o.net/docs/v3/customization/ui)）：
  - `?embed=1` 隐掉侧边栏/控制栏/聊天，只留画面；`?cast=1` 更彻底
  - `?usr=<user>&pwd=<pwd>` 预填凭据，观众端不弹登录框（[FAQ](https://neko.m1k1o.net/docs/v3/faq)）
  - `?volume=`/`?scroll=`/`?lang=`/`?show_side=1`/`?mute_chat=1`
  - `NEKO_SESSION_IMPLICIT_HOSTING=true`：一碰画面就自动获得控制权，无需点"请求控制"
  - → 前端放 N 个 iframe（`allow="fullscreen *"`），每个指向一个 neko 实例。**多平台 = 多容器 + 多 iframe**，不要指望一个实例跑多个平台。
- **多实例编排**：[neko-rooms](https://github.com/m1k1o/neko-rooms) 提供 GUI + API 按需创建容器、挂持久化目录、GPU 镜像、Traefik 一键装（API bearer token 仍在 roadmap）。
- **相对本项目需求的缺口**：Linux only（撞 R3）、CJK 输入法无官方方案、其余（按窗口视图、音频隔离、硬编、嵌入、局域网延迟）都满足。**定位：前端与控制面的最佳试验场。**

### 6.3 Windows 侧的两条路线

**W-a 先通链路：webrtc-streamer。** Windows x64 有 CI 构建；支持 `window://`（内部即 `webrtc::DesktopCapturer::CreateWindowCapturer`，**按窗口采集**）；自带 STUN/TURN；`-X` 可关 X-Frame-Options 以便 iframe；提供 `webrtcstreamer.js` 与 `<webrtc-streamer>` WebComponent；甚至自带 `layout=NxM` 宫格页（[README](https://github.com/mpromonet/webrtc-streamer)）。短板：音频是设备级（`audiocap://`），无按进程隔离；输入注入需另开通道。

**W-b 目标形态：GStreamer 自建代理。**

```bash
# 视频（单平台一路）
d3d11screencapturesrc window-handle=<HWND> capture-api=d3d11 \
  ! d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12 \
  ! nvh264enc bitrate=12000 rc-mode=cbr gop-size=60 zerolatency=true \
  ! rtph264pay config-interval=-1 pt=96 \
  ! application/x-rtp,media=video ! webrtcbin name=sendrecv
```

三个必须提前知道的坑：

1. `window-handle` 要自己 `EnumWindows` 找 HWND —— **GStreamer 不提供窗口枚举**（[论坛](https://discourse.gstreamer.org/t/capturing-a-specific-windows-on-windows10-with-d3d11screencapture/1924/3)）。
2. **进 RDP 会话会让 DXGI 模式的 `d3d11screencapturesrc` 失效**（[论坛](https://discourse.gstreamer.org/t/can-not-using-d3d11screencapturesrc-with-dxgi-mode-while-using-remote-desktop/3882/2)）。不要一边 RDP 登录采集机一边推流。
3. **按进程抓音频的 `wasapi2src loopback-target-pid` 目前不可靠**（[社区报告 1.28.x 取不到音频](https://discourse.gstreamer.org/t/struggling-with-wasapi2src-with-loopback-target-pid/5760)）。

另有两条运行前提：**Windows 一旦锁屏，桌面合成停摆，采集会黑屏**（需常驻登录、禁锁屏/睡眠/屏保）；**最小化的窗口捕获会失败**（窗口不能最小化）。

---

## 7. 焦点三档模型（对 R5 的细化）

| 档 | 条件 | 远端 Chrome | 视频流 | 客户端解码 | 音频 |
|---|---|---|---|---|---|
| **A 焦点** | 用户点中的视图 | 窗口置前、tab 激活 | 全帧率全码率 | 解码 | 开 |
| **B 视窗内非焦点** | 可见但未聚焦 | 窗口非置前、tab 非激活 | 降档（5fps/1Mbps）或停编码 | 不解码 | 静音 |
| **C 视窗外** | 滚出 viewport | 窗口非置前、tab 非激活 | 停编码（保留 PeerConnection） | 不解码 | 静音 |

1. **档位切换优先在服务端和 CDP 做，不要动 SDP**（重协商会引入 ICE/关键帧抖动）；恢复时强推关键帧。
2. **"不把 MediaStream 挂到 `<video>` 上是否真的停止解码"必须实测** —— 收流端可能仍解码后丢帧。若实测如此，服务端停编码是唯一可靠手段。
3. **带宽不是瓶颈**：LAN 千兆下 5 路 1080p60 ≈ 40–60 Mbps。**真正的约束是客户端 GPU 解码器路数上限**——这才是 B/C 档必须"不解码"的原因。
4. 策略 A 顺带依赖 Chrome 自身的前台节流（非激活 tab 的 rAF/定时器被节流，但 WebSocket 消息照常到达，聊天不漏）。
5. 焦点切换 = `Target.activateTarget`（CDP）+ `SetForegroundWindow`（Win32），不要模拟点击。

**如果走 §3 原生路径**：这一节整体退化为 `view.setVisible()` + `webContents.focus()`，Chromium 自动处理节流。

---

## 8. 专题：视频与解码（回答 R4）

用户提问："有办法把社媒平台的视频流转到用户机器上进行解码吗？"

**T1 — WebRTC 重编码（v1 采用，已满足需求）**
服务端只编码、客户端硬件解码，这本来就是 WebRTC 的默认分工。守住纪律：服务端必须**硬编**（NVENC/QSV/AMF），客户端 Chrome 硬解，**全链路零软编**。因为 R6 是局域网，可直接给足码率（1080p60 12–20 Mbps，4K 40 Mbps），重编码画质损失可忽略。

**T2 — 原画质直通（v2 可选"原画质"按钮）**
CDP `Network.responseReceived`/`Fetch` 拦截 `.m3u8`/`.mpd`/`.mp4`，或拦 MSE 的 init+segment 自拼 fMP4，把地址交给客户端 `<video>`。收益：原画质、服务端零编码。代价：签名 URL 过期、`blob:` 需自组装、DRM(EME) 无解、各平台格式不同。**不要放进 v1。**

**T3 — 混合叠层（不推荐）**：像素流铺页面 + 视频区叠 T2 的 `<video>`。滚动/布局同步极难做对，收益不如 T1 直接给高码率。

---

## 9. 专题：音频（R7）

难点不在传输（WebRTC 就是 Opus），在于**服务端能否按视图分离音源**。

- Linux/neko：每容器一套 PulseAudio，天然隔离。
- Windows：`wasapi2src loopback=true`（系统混音）稳定；按进程的 `loopback-target-pid` 不可靠（§6.3 第 3 条）。

**v1 折中（推荐）**：一路系统 loopback 混音 + 控制面把非焦点平台标签页静音（CDP 注入 `video/audio.muted = true`，或扩展 API `tabs.update({muted:true})`）。任何时刻只有一个视图是焦点，所以听到的就只有焦点的声音——用一个靠谱机制换掉一个不可靠机制。

客户端侧：只给焦点视图的 `<video>` 取消静音，其余 `muted`；注意 autoplay 策略需要一次用户手势（放一个"启动"按钮）。

---

## 10. 专题：输入法与输入体验（R9/R10）

"直接透传即可"要纠正 —— **透传分两种，都不完整**：

| 方式 | 机制 | 优点 | 缺点 |
|---|---|---|---|
| **键码透传** | scancode → SendInput | 快捷键、Enter、方向键语义完整 | 候选框在远端，延迟叠加；本地/远端 IME 互相打架 |
| **文本透传** | 本地 IME 组合完送最终字符串（CDP `Input.insertText` 或 `SendInput` + `KEYEVENTF_UNICODE`） | 候选框在本地，体验最接近本地 | 丢失 keydown 语义，破坏 Enter 发送、@ 提及、快捷键 |

**推荐混合模式**（成熟远程桌面客户端与 [Apache Guacamole](https://guacamole.apache.org/) 的做法——Guacamole 用隐藏 textarea 承接组合，协议里有独立的 `text` 指令）：

- 可打印字符 / 中文 → **文本透传**
- `Enter`/`Tab`/`Esc`/方向键/`Ctrl`+`Shift` 组合/功能键 → **键码透传**
- 必须处理**本地与远端 IME 的开关同步**（本地组合时确保远端 IME 关闭，反之亦然）

其他"和本地一样"的细节：DPI 感知下的鼠标绝对坐标映射、滚轮、中键、拖拽、剪贴板双向、多显示器、中文标点。

---

## 11. 逃逸口：如果坚持"客户端只能是一个普通网页"

浏览器扩展 + 放开的 iframe。这是真实可用的组合：

1. **扩展用 MV3 `declarativeNetRequest` 的 `modifyHeaders` 移除响应头** `x-frame-options` 与 `content-security-policy`（需要对应站点的 host 权限）。商店里已有现成扩展（如 "iFrame Unlocker – Remove X-Frame-Options & CSP"）证明这条路可行。
2. **iframe 加 `sandbox`，且不加 `allow-top-navigation`** → 规范保证 frame-busting 跳转（`top.location = self.location`）失效。其余按需给 `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`。
3. 隐患：
   - 平台 JS 仍可 `window.top !== window.self` **检测嵌套**并降级或拒绝 → 无法根治，只能逐个平台试。
   - iframe 是**第三方上下文**，登录态依赖 Chrome 的第三方 Cookie 政策 —— 2025 年 Google 已放弃"默认禁用第三方 Cookie"，目前可用，**但这是政策变量**，且 Safari/Firefox 更严格。
   - OAuth 登录弹窗需要 `allow-popups` + `allow-popups-to-escape-sandbox`。
4. 判定：**能跑，但脆，做不到"和本地一样"，且完全依赖扩展安装。** 仅在 §3 不可行时采用。

---

## 12. 未定问题

**已定**（2026-10-02）：客户端必须纯网页 → §3 原生多视图、§11 扩展方案双双出局。

**验证路径 B（§14）唯一需要的关键输入：**

1. **目标平台的完整清单，按重要性排序。** 验证方案就是逐个平台测过去——清单越准，结论越快越可信。
2. **每个平台你实际要做什么？** 只浏览 / 要发帖点赞 / 要看视频 / 要私信聊天。
   这决定 §14.4 里哪些坑是致命的、哪些可以容忍。
3. **"所有设备"具体是哪些？** Windows / macOS / Linux 桌面、iOS、Android、平板、电视？浏览器分别是
   Chrome / Safari / Firefox？——**Safari 与 Firefox 的 Service Worker 与第三方 Cookie 行为更严**，
   会直接影响路径 B 的可用面。
4. **是否接受"所有设备共享同一个登录会话"？**（服务端 Cookie jar 的必然结果，也正是跨设备连续性的来源）

**若最终仍要走 §6 远程渲染：**

5. Windows 版本（Win11 22H2+ 才有较好的按应用音频路由）？
6. GPU 型号（决定 NVENC / QSV / AMF 硬编路径）？
7. 采集机能否常驻登录、禁锁屏、且不与其上的 RDP 会话冲突？
8. 接受"先 webrtc-streamer 通链路、再自建 GStreamer"两步走吗？
9. 是否考虑直接购买 BrowserBox（注意其 Windows 版无音频）？

---

## 13. 里程碑建议（v0.2 重排）

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 ✅ 已完成**（2026-10-02） | 路径 B 可行性 spike：Docker 栈 + Scramjet + 多视图 hub + 无头验证 | 已产出逐平台 ✅/⚠️ 表（§14.7）：B站/知乎/酷安 ✅，抖音 ⚠️ 验证码 |
| **M2 ✅ 已完成**（2026-10-02） | HTTPS（自签根 CA + Caddy 443 终结），局域网设备可用 | 证书链/SAN/WS 升级/SW 注册四项全过，见 §14.8 |
| **M1（进行中）** | 用**真实浏览器 + 真实账号**登录四个平台并操作一遍 | 点赞/发帖/私信/视频播放是否正常；据此判定「纯 B / B+A 混合 / 纯 A」并写入本文件 |
| **M3** | 多视图与焦点调优 | 焦点决定可见区域；N 路并存；切焦点流畅；非焦点降档 |
| **M4** | 持久化与跨设备 | 布局、已打开内容、进度跨设备恢复 |
| **M5**（仅当 M1 判定含路径 A） | 路径 A 实现 | §6–§10 |

---

## 14. 路径 B：拦截代理 —— 让用户的浏览器自己渲染

### 14.1 为什么这条路能绕开像素流

X-Frame-Options 和 CSP `frame-ancestors` 都只是**响应头**。反代一次就能改掉。
把平台页面经你自己的代理服务出去，浏览器就会**把它当成你自己的页面来渲染**——
而渲染一旦回到本地，§9 / §10 / §8 的全部难题（音频隔离、输入法透传、硬解码转发）**整体消失**，
因为它们本来就是浏览器的原生能力，而不是需要你去实现的功能。

代价从"搭建一整套远程浏览器基础设施"转移到了"**URL 重写要足够完整**"。

### 14.2 机制

1. 反向代理把 `hub.local/p/<平台>/...` 转发到真实站点，**剥掉** `x-frame-options`、
   改写 `content-security-policy`（去掉 `frame-ancestors`），并在服务端维护 Cookie jar。
2. 向页面注入一个 **Service Worker**，拦截页面发出的**所有**请求
   （fetch / XHR / WebSocket / Worker / 媒体），把它们改写成走代理的 URL。
3. 服务端用 HTML / CSS / JS 重写器改写响应体里的绝对 URL、`location` 访问、
   `eval` / `Function` 构造、`importScripts` 等动态代码路径。

第 2、3 步就是 Ultraviolet / Scramjet 的全部内容——**不要自己从零写**。

### 14.3 现成实现

- **[Scramjet](https://docs.titaniumnetwork.org/proxies/scramjet/)**（MercuryWorkshop）——**当前唯一在维护的一代**。
- **[Ultraviolet](https://docs.titaniumnetwork.org/proxies/ultraviolet/)**——**已停止维护**，官方明确要求迁移到 Scramjet
  （理由写得毫不客气：*"no valid reason for including Ultraviolet … unnecessary tech debt. You have been warned!"*）。
- **Rammerhead**——另一条独立实现（会话式重写），可作为对照。
- 官方文档列出的已验证站点包括 **Google、Discord、Reddit**。Discord 是重 SPA，
  这说明机制对复杂前端**是可行的**——但不等于对社媒也可行，这正是要实测的原因。
- 配套：`bare` / Wisp 传输层负责让 Service Worker 能发出真实网络请求。
  **HTTPS 是 Service Worker 的硬性前提**（工作区里已有 `LocalCA` 与 `caddy-dsh`，正好够用）。

### 14.4 必然踩到的坑（按概率排序）

1. **MSE / `blob:` 视频**——社媒普遍用 MediaSource 喂视频，`blob:` URL 不经过网络层、SW 拦不到，
   需要另外挂钩 `MediaSource.addSourceBuffer` / `SourceBuffer.appendBuffer` 把分片也代理掉。
   **这是最容易碎的一环。**
2. **WebSocket / SSE**——必须代理并保持长连接。
3. **严格 CSP**——响应头能改写，但页面内 `<meta http-equiv="Content-Security-Policy">` 也要处理。
4. **子资源完整性 (SRI)**——重写过的 JS/CSS 会让 `integrity` 哈希失配而被拒，需连同该属性一起处理。
5. **`location.origin` / `document.domain` / 跨子域逻辑**——站点代码认为自己在 `x.com`，实际在 `hub.local`，行为会漂。
6. **风控检测**——平台可能检查是否被代理（响应头顺序、TLS 指纹、Referer、特征变量）。
   用**办公室真实 IP + 客户端真浏览器**能规避掉大部分，但代理特征本身是新增风险。
7. **CORS / Cookie**——服务端 Cookie jar 模式下各客户端共享同一会话。
   这**正好**满足 R2 的跨设备需求，但要接受"所有设备是同一个登录会话"。
8. **DRM (EME)**——可能失效；但客户端是真浏览器、有真 Widevine，
   理论上比像素流方案**更有机会播**带 DRM 的内容。

### 14.5 建议立刻做的 1–2 天验证（不要再在文档里推演）

1. 用 Caddy + LocalCA 起 `https://hub.local`（Service Worker 需要 HTTPS）。
2. 部署 Scramjet-App 或 Rammerhead 作为代理。
3. 写一个最小多视图页面：N 个 iframe，每个指向一个平台。
4. **逐个平台记录三类结果**：✅ 能用 / ⚠️ 半残（能看不能发、视频不播）/ ❌ 完全不能用。

产出那张表就直接决定终局架构：

| 验证结果 | 终局架构 |
|---|---|
| 全部 ✅ | **整套方案坍缩成"一个代理 + 一个页面"**，§6–§11 全部作废 |
| 部分 ❌ | **混合架构**：能用的走路径 B（本地渲染、体验原生），少数不能用的平台单独走路径 A（只为它们付像素流的成本） |
| 全部 ❌ | 回到路径 A，但你此时已经确知别无选择 |

> 按工作区约定，长驻开发服务需先 `devctl probe` → 提报用户确认 → `devctl register` 之后才能启动，
> 不能直接 `run_in_background` 起服务。

### 14.6 一个买来即用的对照项：BrowserBox

**[BrowserBox](https://github.com/BrowserBox/BrowserBox)**（DOSAYGO）是商业 RBI，与路径 A 同族，但有两点值得记录：

- 优点：客户端免安装；支持 **Windows**；提供 `<hyper-frame>` 嵌入元素（自称 *"the unlimited iframe"*），
  正好对应本项目需求；60 FPS 且支持 WebRTC；官方明确支持 LXC 与多席位 `bbx fleet`。
- 缺点：**Windows 上不支持音频**（官方文档明列："Two things are not available on Windows: audio, and the
  multi-user commands"）；一机一会话（多席位仅 Linux）；**非开源**（旧源码已于 2026-03 移除）；
  商业授权 $119/user/年。

→ 撞 R7（音频），不作为首选；仅在"走路径 A 且不想自己写采集代理"时作为备选。

### 14.7 M0 验证结果（2026-10-02 实测，已通过）

已按 §14.5 建好 Docker 栈并跑通无头验证（实现与用法见
[README.md](./README.md)，截图见 `verify/out/shots/`）。

**验证条件**：无头 Chromium（`chrome-headless-shell` 151），冷启动、**未登录**，
出口为办公室真实 IP，hub 经 `http://127.0.0.1:18095` 访问。

| 平台 | 结论 | 证据 |
|---|---|---|
| **哔哩哔哩** | ✅ **完全可用** | 1534 个节点；首页导航/搜索/轮播/视频卡/播放量/UP 主/时长全部正常。仅 5 个 `i0/i1.hdslb.com` 轮播封面请求失败 |
| **知乎** | ✅ **可用** | 239 个节点；302 到 `/signin?next=%2F`（未登录的正常行为），扫码/验证码/密码三种登录表单完整渲染 |
| **抖音** | ⚠️ **撞验证码** | 落到「验证码中间页」滑块拼图。无头浏览器本身是风控特征，真机可能不需要 |
| **酷安（官方站）** | ✅ **可用** | 170 个节点；V16 首页正常 |
| **自建酷安 Web 版** | 无需代理 | 自己控制，直接 iframe；注意 hub 开了 `COEP: require-corp`，需为它加 `Cross-Origin-Resource-Policy: cross-origin`，或对 hub 关闭 COEP |

**结论：路径 B 成立。** 四个平台里三个完全可用，且这一路**没有引入** WebRTC、
采集编码、输入注入、音频隔离、输入法透传中的任何一项——§6–§10 对这三个平台全部作废。

**本轮仍未验证（也是真正的关键，不要被上面的 ✅ 冲昏头）：**

1. **登录 + 交互**：只证明了「能加载」。点赞、发帖、私信、**视频播放**必须用真实账号在真实浏览器里点一遍。
2. **MSE / `blob:` 视频**：Scramjet 不拦截 MediaSource（§14.4 第 1 条），视频能否播放是最大未知数。
3. **无头 vs 真机**：抖音的验证码有多少归因于无头浏览器、多少归因于代理改写，需要真机对照。
4. **长连接稳定性**：SPA 的 WebSocket / SSE 在代理下的长时间表现。

**M1 判定（待用户用真实浏览器验证后确认）**：预计为「纯 B + 少数平台退 A」的混合，
其中抖音是唯一的高风险项。

### 14.8 M2 验证结果：HTTPS 已就绪（2026-10-02 实测，已通过）

局域网 IP 上的 `http://` **不是安全上下文**，Service Worker 注册不了——
这是路径 B 唯一的部署硬约束，必须用 HTTPS 解决。

**方案**：`tls/gen-certs.sh` 生成自签根 CA（10 年）+ 服务器证书（397 天，SAN 含 LAN IP
与 localhost）；Caddy 在 **443** 做 TLS 终结并反代到 `127.0.0.1:18095`，
另在 **18096** 用明文 HTTP 提供 CA 下载——未装 CA 的设备在这个端口不会遇到证书警告，
可以完成引导。

**为什么不直接自签一张叶子证书**：叶子直接自签时浏览器只能"点过警告"，
而**该状态下 Service Worker 能否注册并不确定**；装一张根 CA 是确定解，且每台设备只需装一次。

**验证结果**：

| 检查项 | 结果 |
|---|---|
| 证书链 | `Verify return code: 0 (ok)` |
| SAN | `IP:10.0.30.61, IP:127.0.0.1, DNS:localhost, DNS:DEV-U26-001` |
| `/wisp/` WebSocket 升级（经 Caddy 反代） | `HTTP/1.1 101 Switching Protocols` |
| HTTPS 下 Service Worker | 注册成功，`__ZOETROPE.ready === true` |
| 四平台加载（HTTPS，连续两轮） | 与 HTTP 一致：bilibili 1513/1533、zhihu 237/239、douyin 79、coolapk 170 |

**顺带修掉一个真实缺陷**（本次最重要的技术发现）：wisp 的 `dns_result_order` 默认值是
`"verbatim"`，其分支为 `resolve_with_fallback(resolve6, resolve4, ...)`——**先解析 AAAA**。
本机没有 IPv6 路由，而 wisp 用裸 TCP、不做 happy-eyeballs，于是只要目标有 AAAA 记录
（bilibili 就有）就必然连接失败，表现为代理**间歇性返回 500**——只有 `resolve6` 恰好失败
才会回退到 IPv4，所以它是随机的，极难排查。必须显式设成 `"ipv4first"`。
这是"本地网络无 IPv6"与"wisp 默认值"叠加出的真实缺陷，不是配置失误。

### 14.9 M3 结果：四个平台定论 + 三个新发现的缺陷（2026-10-02 实测）

用户实际入口是 SSH 隧道到 `127.0.0.1:18095`（不是 LAN IP），据此重跑并逐个定位：

| 平台 | 终局 | 关键事实 |
|---|---|---|
| 哔哩哔哩 | ✅ 完全可用 | 修复传输层预热后**连续 5 轮 5/5 成功** |
| 知乎 | ✅ 可用 | 未登录落到 `/signin`，属正常行为 |
| 自建酷安 Web 版 | ✅ 可用 | 信息流、图片、热榜全部渲染 |
| **抖音** | ❌ **被风控拦在代理链路** | **顶层文档打开同一代理 URL 同样是验证码页 → 已排除框架检测** |

**抖音的排查过程与结论**（三个假设逐一排除）：

| 假设 | 实测 | 结论 |
|---|---|---|
| 代理改写失败 | 18 个 douyin 路由请求，`rmc-captcha` 正常加载，WebGL 正常 | ✗ |
| 框架检测 | 顶层文档打开同一代理 URL，仍「验证码中间页」 | ✗ |
| 资源加载失败 | 无 4xx/5xx | ✗ |

→ 剩下最可能是**传输层指纹**：libcurl-transport 的 WASM libcurl 有独立的 TLS ClientHello（JA3）
与 HTTP 头顺序，与真 Chrome 不同，风控据此识别。**抖音这一个平台应单独退到路径 A（§6）**，
这正是 §14.7 预判的唯一高风险项，现在被证实。

**期间发现并修掉的三个真实缺陷：**

1. **传输层 WASM 懒加载导致第一个平台间歇性失败（约 50%）** ——
   日志 `Error: wasm not loaded yet, please call libcurl.load_wasm first`。
   `platforms[0]` 的第一个请求撞在 WASM 加载完成之前。
   修法：建 frame 前先用 `scramjet.encodeUrl()` 打一个极小的预热请求并重试至成功
   （`hub.js` 的 `warmUpTransport`）。修复后 5/5。
2. **COEP 会拦掉自建酷安的跨源 iframe** —— 即使 `credentialless` 也白屏。
   实测 `COEP=off` 时酷安全部渲染**且代理照常工作**（说明 libcurl WASM 并不需要跨源隔离），
   故默认改为 `off`。
3. **直连站点必须与 hub 同站** —— 自建酷安的会话 Cookie 是 `SameSite=Strict`，
   跨站不发送，应用报"缺少或无效的会话 token"。用 `{host}` 占位符按 hub 主机名拼地址解决。
   HTTPS 入口还需在**其自己的 Rust 服务**上加 `--allow-origin https://10.0.30.61:17521`
   （`coolapk-core/src/ctx.rs:112` 的 Origin 白名单，是有意的安全控制）。

---

## 15. 参考

- **路径 B 核心**：[Scramjet 文档](https://docs.titaniumnetwork.org/proxies/scramjet/) · [Ultraviolet（已弃用，官方要求迁移）](https://docs.titaniumnetwork.org/proxies/ultraviolet/) · [Scramjet-App 部署示例](https://github.com/MercuryWorkshop/Scramjet-App) · [拦截代理重写指南](https://docs.titaniumnetwork.org/guides/interception-proxy-guide/rewriting/)
- **BrowserBox**：[GitHub](https://github.com/BrowserBox/BrowserBox)（商业；Windows 无音频；`<hyper-frame>` 嵌入）
- Menlo Security ACR / DOM Mirroring：[Doing RBI Right](https://www.menlosecurity.com/blog/considerations-on-closing-the-browser-security-gap-part-5-doing-rbi-right)（像素流 RBI 的体验问题、DOM Mirroring 的定位与"剥离主动内容"的前提）
- 原生页面替换 iframe 的同一问题解法：`anywhere-labs/dsh-desktop` [PR #1088 — use native pages in the sidebar browser](https://github.com/anywhere-labs/dsh-desktop/pull/1088)
- 扩展移除 X-Frame-Options/CSP 的现成实现：[iFrame Unlocker (Chrome Web Store)](https://chromewebstore.google.com/detail/iframe-unlocker-%E2%80%93-remove/jkijbninecngmcipaijcnibjhbejaoch)
- n.eko：[官网](https://neko.m1k1o.net/) · [采集配置](https://neko.m1k1o.net/docs/v3/configuration/capture) · [UI 与 embed 参数](https://neko.m1k1o.net/docs/v3/customization/ui) · [FAQ（IME 与 iframe）](https://neko.m1k1o.net/docs/v3/faq) · [neko-rooms](https://github.com/m1k1o/neko-rooms)
- selkies-gstreamer：[README](https://github.com/selkies-project/selkies-gstreamer)（noVNC/Guacamole 的高性能替代，Linux，Windows 支持仍在计划中）
- webrtc-streamer：[README](https://github.com/mpromonet/webrtc-streamer)（Windows x64 构建、`window://` 按窗口采集、可嵌入 JS/WebComponent）
- GStreamer on Windows：[按窗口采集](https://discourse.gstreamer.org/t/capturing-a-specific-windows-on-windows10-with-d3d11screencapture/1924/3) · [按进程音频的现状](https://discourse.gstreamer.org/t/struggling-with-wasapi2src-with-loopback-target-pid/5760) · [RDP 与 DXGI 采集冲突](https://discourse.gstreamer.org/t/can-not-using-d3d11screencapturesrc-with-dxgi-mode-while-using-remote-desktop/3882/2)
- Neko 3.0 多浏览器支持报道：[heise](https://www.heise.de/en/news/Virtual-browser-environment-Use-Firefox-Chrome-Co-in-Docker-with-Neko-3-0-10337659.html?view=print)
