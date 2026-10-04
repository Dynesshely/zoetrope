# zoetrope

**西洋镜** —— 一个箱子里装着好几幅画，一次只看得到一幅，靠转动切换。
这个项目就是这个箱子：多个平台同处一页，**焦点决定可见区域**，非焦点的降档而不是断开。

服务端只做 **URL 重写 + 头剥离**，页面由**用户自己的浏览器**渲染——所以输入法、音频、
视频硬解、滚动、复制粘贴全部是原生能力，不需要像素流。

实现基于 [Scramjet](https://github.com/MercuryWorkshop/scramjet)（拦截式 Web 代理，
AGPL-3.0）与其参考应用 [Scramjet-App](https://github.com/MercuryWorkshop/Scramjet-App)，
见 `vendor/Scramjet-App/`。

> **M0/M2 已通过。** 四个目标平台中三个完全可用；HTTPS 已就绪，局域网设备可用。
> 详见「验证结果」。
>
> 命名谱系与 `astrolabe`（星盘）同属古典观测仪器一类。
> 备选名曾考虑 `lightwell`（天井／凿壁偷光——强调"绕过墙把光引进来"这个机制），
> 最终选了强调**行为**而非机制的 `zoetrope`。

---

## 访问入口

| 用途 | 地址 | 需要装证书？ |
|---|---|---|
| **桌面（SSH 隧道，最快）** | `http://127.0.0.1:18095/` | **不需要** |
| **其他设备（手机/平板/电视）** | <https://10.0.30.61/> | 需要，装一次 |
| **根证书引导页** | <http://10.0.30.61:18096/> | —— |
| 本机调试 | <http://127.0.0.1:18095/> | 不需要 |

### 路径一：SSH 隧道（零证书，桌面首选）

`127.0.0.1` 属于浏览器的"可信来源"，本身就是安全上下文，Service Worker 直接可用，
**不需要任何证书**。已有的 SSH 连接上加两个转发——第二个是给自建酷安 Web 版用的，
它必须与 hub **同站**，否则 `SameSite=Strict` 的会话 Cookie 不会发送：

```bash
ssh -N -L 18095:127.0.0.1:18095 -L 17520:127.0.0.1:17520 <user>@10.0.30.61
# 然后浏览器打开 http://127.0.0.1:18095/
```

写进 `~/.ssh/config` 可以免每次敲：

```
Host smv
    HostName 10.0.30.61
    LocalForward 18095 127.0.0.1:18095
    LocalForward 17520 127.0.0.1:17520
```

### 路径二：装根证书（手机等无法隧道隧道设备）

打开 <http://10.0.30.61:18096/>，明文 HTTP，不会有证书警告，页面里有各系统步骤。

### ⚠️ 为什么"点过证书警告"不能用（已实测）

一个常见误解是"https 有加密就行，浏览器报不安全无所谓"。**这条路是死的。**
实测（`verify/cert-bypass-check.mjs`，用 CDP 的 `Security.setOverrideCertificateErrors` +
`handleCertificateError(continue)` 精确模拟用户点"继续"）：

```
收到 Security.certificateError: ERR_CERT_AUTHORITY_INVALID
已代替用户执行 continue（等价于点过警告）
isSecureContext : true          ← 页面确实被当成安全上下文
registerResult  : REGISTER_FAIL  SecurityError:
                  Failed to register a ServiceWorker for scope ('https://10.0.30.61/')
                  with script ('https://10.0.30.61/sw.js'):
                  An SSL certificate error occurred when fetching the script.
smvReady        : false
```

**`isSecureContext` 是 `true`，但 Service Worker 依然被硬性拒绝。**
点"继续"只让页面能显示，不会让浏览器信任该来源去注册 Service Worker——
而整个拦截代理就架在 Service Worker 上，所以代理内核永远起不来。

同理，`http://10.0.30.61:18095`（局域网 IP 上的明文 HTTP）也不是安全上下文，同样不行。

---

## 结构

```
docker-compose.yml      hub（代理+页面） + tls（Caddy TLS 终结）
proxy/
  Dockerfile            复用 vendor/Scramjet-App 的依赖清单，只替换 src/ 与 public/
  src/index.js          Fastify：/  /scram/  /libcurl/  /baremux/  /wisp/  /healthz
  public/index.html     多视图界面
  public/hub.js         视图调度 + window.__ZOETROPE（供自动化验证读取状态）
  public/platforms.js   平台清单 ← 改这里增删平台
  public/sw.js          Scramjet Service Worker
tls/
  gen-certs.sh          生成自签根 CA + 服务器证书（SAN 含 LAN IP）
  Caddyfile             443 TLS 终结 → 127.0.0.1:18095；18096 提供 CA 下载
  certs/                ca.crt / ca.key / server.crt / server.key（不入库）
  site/                 证书安装引导页
verify/cdp-check.mjs    无头验证：逐平台探测 DOM + 截图（只用 Node 内置能力）
vendor/Scramjet-App/    上游参考实现（只读）
```

## 用法

**仓库里没有的东西**（`.gitignore` 有意排除，都要自己生成/拉取）：

| 路径 | 怎么来 |
|---|---|
| `tls/certs/` | `make certs` 生成。里面有 `ca.key` / `server.key`，**绝不入库** |
| `vendor/Scramjet-App/` | git 子模块，`git submodule update --init` 拉取。`proxy/Dockerfile` 会 `COPY` 它的 `package.json` + `pnpm-lock.yaml` 复现上游依赖集 |
| `verify/*/`、`verify/*.png` | 验证脚本的产物（累计约 239MB），不入库；脚本本身 `verify/*.mjs` 是入库的 |

构建需要 `DOCKER_CONFIG` 指向工作区里的 docker 配置——那里有 registry 认证，
以及 BuildKit 会自动注入构建容器的 HTTP 代理（本机容器出网必须走它）：

```bash
export DOCKER_CONFIG=/home/dynesshely/dsh-workspaces/tools/.docker-config

make certs        # 生成自签证书（已存在则跳过）
make build        # 构建镜像
make up           # 启动 hub + tls
make url          # 打印访问地址
make check-cert   # 校验证书链
make verify-https # 无头验证 HTTPS 端 → verify/out-https/
make down         # 停止
```

**证书 397 天到期**，届时 `make renew-certs` 重新生成（客户端已信任的根 CA 十年有效，不用重装）。

---

## 关键环境适配（都是本机踩出来的）

| # | 问题 | 现象 | 处理 |
|---|---|---|---|
| 1 | **传输层 WASM 懒加载，第一个请求必被拒** | `platforms[0]` **间歇性加载失败**（约 50%），日志 `Error: wasm not loaded yet, please call libcurl.load_wasm first` | 创建 frame 之前先用 `scramjet.encodeUrl()` 打一个极小的预热请求，直到成功（`hub.js` 的 `warmUpTransport`）。修复后连续 5 轮 5/5 成功 |
| 2 | **wisp 默认 `dns_result_order="verbatim"`，先解析 AAAA** | 目标有 AAAA 记录时（bilibili 就有）代理**间歇性 500** | 改为自定义 `dns_method`：只用系统解析器取 IPv4，任何情况下都不回退到 AAAA（`proxy/src/index.js`）。本机无 IPv6 路由，wisp 又是裸 TCP、不做 happy-eyeballs |
| 3 | Wisp 走**裸 TCP**，不经过 `HTTP_PROXY` | 上游默认用 Cloudflare 的 1.1.3 做解析器，本网络不通 | 改用系统解析器 10.0.30.51（`dns_method`） |
| 4 | npm registry 在 Cloudflare 上，容器直连不通 | 构建期装不上依赖 | 构建期经 `DOCKER_CONFIG` 里的代理；运行期不需要 |
| 5 | 无头 Chromium 缺中文字体 | 截图里中文全是 □ | `FONTCONFIG_FILE=.../tools/.fonts/fonts.conf` |
| 6 | Service Worker 需要安全上下文 | 局域网 `http://10.x.x.x` 无法注册 SW | Caddy 在 443 上做 TLS 终结（本目录 `tls/`）；或用 SSH 隧道走 `127.0.0.1` |
| 7 | **浏览器"点过证书警告"不等于信任** | https 页面能显示，但 Service Worker 被 `SecurityError: An SSL certificate error occurred` 硬拒 | 必须真正信任证书（装根 CA），或改走 `127.0.0.1` 隧道。实测见 `verify/cert-bypass-check.mjs` |
| 8 | **COEP 会拦掉自建酷安的跨源 iframe** | 即使 `credentialless` 也白屏；`require-corp` 更不行 | COEP 默认设为 `off`（`COEP=credentialless` 可切回）。实测：`off` 时酷安全部渲染且代理照常工作 |
| 9 | **直连模式的站点必须与 hub 同站** | 酷安报「缺少或无效的会话 token，请通过服务端地址访问本服务」 | 会话 Cookie 是 `SameSite=Strict`（`coolapk-desktop/vite.config.ts`），跨站不发送。用 `platforms.js` 的 `{host}` 占位符按 hub 自己的主机名拼地址 |
| 10 | **`decodeUrl()` 对非代理地址会无条件切片** | 「在弹层里打开视频」弹出空白子视图，地址栏是 `about:blank`；而且**只有长的 URL 会中招**，短的反而正常，看起来像随机 | 调用前先判断地址确实以 `location.origin + "/scramjet/"` 开头（`hub.js` 的 `isProxiedUrl` / `toRealUrl`），并只接受 `http(s)://` 形式的解码结果。详见 `UI.md` §16 |
| 11 | **面板的 z-index 比弹层高** | 弹层看起来"半透明"（其实是面板 `opacity: 0.72` 盖在上面），`#veil` 也从来没压暗过任何面板 | 层级写成契约：面板 `10-\|d\|`（焦点 20）< `#veil` 30 < `#overlay` 31。像素级判定脚本 `verify/overlay-alpha-check.mjs`。详见 `UI.md` §17.1 |
| 12 | **四个同源 iframe 挤在同一个渲染进程里同时开** | 各平台首屏明显慢于原生标签页 | 按「到焦点的环绕距离」分三批放行导航（`bootNavigateOrdered`）；远端面板 `content-visibility: hidden` 停渲染。bilibili 首屏 complete 7.7s → 3.8s，详见 `UI.md` §17.2 |

---

## 验证结果

| 平台 | 结论 | 证据 |
|---|---|---|
| **哔哩哔哩** | ✅ **完全可用** | 1500+ 节点；首页导航/搜索/轮播/视频卡/播放量/UP主/时长全部正常。预热修复后连续 5 轮 5/5 稳定 |
| **知乎** | ✅ **可用** | 240 节点；302 到 `/signin`（未登录的正常行为），扫码/验证码/密码三种登录表单完整渲染 |
| **自建酷安 Web 版** | ✅ **可用**（隧道入口实测） | 信息流、帖子图片、用户信息、本月热榜、热门话题全部渲染。见下方说明 |
| **抖音** | ❌ **被风控拦在代理链路上** | 落到「验证码中间页」。**已排除框架检测**：顶层文档打开同一代理 URL 同样是验证码页 |

**HTTP 与 HTTPS 两条链路都验证过**，传输层检查均通过：

- 证书链校验 `Verify return code: 0 (ok)`
- SAN 覆盖 `IP:10.0.30.61, IP:127.0.0.1, DNS:localhost, DNS:DEV-U26-001`
- `/wisp/` WebSocket 升级 `HTTP/1.1 101 Switching Protocols`
- HTTPS 下 Service Worker 注册成功（`__ZOETROPE.ready === true`）

### 自建酷安 Web 版的两个前提

1. **COEP 必须是 `off`**（默认已是）。`credentialless` 也会让它白屏。
2. **必须与 hub 同站**。会话 Cookie 是 `SameSite=Strict`，跨站不发送。
   所以隧道入口还要多转发一个 `17520`（见上）。
   **HTTPS 入口还需要你在自己的 Rust 服务上加白名单**：

   ```bash
   --allow-origin https://10.0.30.61:17521
   ```

   这是 `coolapk-core/src/ctx.rs:112` 的 `is_allowed_origin` 在把关（代码注释写明
   "登录回跳会把用户的 Cookie 拼在地址上带回本地，因此**绝不能**接受任意来源"）——
   这是有意的安全控制，不是 bug。白名单 = `base_url` + `--allow-origin` 指定的源。
   **我没有重启你的服务进程**，需要你自己带上这个参数重启。

### 抖音：为什么这条路走不通

先排除了几个假设：

| 假设 | 实测 | 结论 |
|---|---|---|
| 代理改写失败 | 18 个 douyin 路由请求，`rmc-captcha` 脚本正常加载，WebGL 正常 | ✗ |
| 框架检测（被 iframe 识别） | **顶层文档**打开同一代理 URL，仍是「验证码中间页」 | ✗ |
| 资源加载失败 | 无 4xx/5xx，代理链路正常 | ✗ |

剩下最可能的原因是 **传输层指纹**：`libcurl-transport` 的 WASM 版 libcurl 有自己的
TLS ClientHello（JA3）与 HTTP 头顺序，和真 Chrome 不同，抖音的风控据此判定为自动化/代理。
无头浏览器本身也是额外的风控特征。

**建议**：先用你的真实浏览器打开一次，手动把滑块验证过掉，看会话 Cookie 建立后能否正常使用。
如果它反复触发，说明是链路指纹问题——**抖音这一个平台建议单独退到"远程渲染"路径**
（真 Chrome 在服务端跑，或直接用真机浏览器），这正是 DESIGN.md 里预判的唯一高风险项。

### 仍未验证

1. **登录 + 交互**：点赞、发帖、私信、**视频播放**必须用真实账号在真实浏览器里点一遍。
2. **MSE / `blob:` 视频**：Scramjet 不拦截 MediaSource，视频能否播放是最大未知数。
3. **长时间稳定性**：SPA 的 WebSocket / SSE 长连接在代理下的表现。

---

## 下一步

先把根证书装到你的设备上，用真实浏览器打开 <https://10.0.30.61/>，
登录四个平台，**重点看视频能不能播**。

然后再决定：

- 若登录后三个平台都正常 → 整个方案的复杂度就到此为止，剩下的是布局/持久化这类常规工作。
- 若某平台交互不可用 → 只有那一个平台退到"远程渲染"路径，代价从一个平台付，见 DESIGN.md §6。
