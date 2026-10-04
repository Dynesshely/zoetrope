# zoetrope — 视图布局与聚焦的 UI 设计

> 目标：**一个页面聚合多个平台视图，并在它们之间聚焦**，且要有真实的 3D 层次感。
> 本文只谈 UI 层；传输与节流策略见 DESIGN.md §7。

---

## 0. 一句话结论

**用"折屏"而非"轮盘"**：焦点面板正对镜头（此时 `transform: none`，像素级清晰），
左右邻位**绕 Y 轴内转 + 后撤 + 压暗**，更远的沿纵深继续后退并淡出。
切换时所有面板只改 `transform` 与 `opacity`——两者都能在合成器上跑完，
**主线程零逐帧工作，且全程不改任何元素尺寸，因此零回流**。

网格总览（真正的"同时查阅"）作为独立模式，与折屏之间用一次"展平"动画连接。

---

## 1. 硬约束：3D + iframe 的现实

这些不是风格偏好，是浏览器的物理限制，直接决定了方案边界：

| 约束 | 后果 |
|---|---|
| 每个被 3D 变换的 iframe 都会获得**独立的合成层与 GPU 纹理**（1080p ≈ 8 MB） | 常驻图层数要有上限；10+ 个 1080p 视图在集显上必崩 |
| 非整数 `scale` / 未对齐的旋转 → 重采样 → **文字发虚** | 焦点态的最终变换必须是轴对齐的恒等变换 |
| **只有 `transform` / `opacity` / `filter` 能走合成器**；`top/left/width/height` 会触发回流 | 切换动画只能碰这三个属性 |
| 改变 iframe **尺寸**会让里面整站重排（可能触发懒加载、图表重绘） | 聚焦切换**绝不允许改尺寸**，只用 `scale` 视觉缩放 |
| `backdrop-filter` 盖在 iframe 上 = 每帧回读 iframe 纹理 | **禁用**。压暗只能用纯色/渐变遮罩 |
| 大半径 `filter: blur()` 同样要重新光栅化 | 慎用；远景最多 1–2px，且只在过渡期间 |
| 可见 ≠ 被节流 | 折屏里邻位是可见的，所以它们**不会**被 Chromium 自动降频——这是本设计最大的性能陷阱，见 §6 |

**第一条推论**：3D 层次感应当来自**位置、角度、明暗、遮挡关系**，而不是模糊与投影。
后者是把"看起来高级"换成"卡"，不划算。

---

## 2. 推荐布局：「折屏 + 纵深走廊」

```
                      ┌──────────────────────────────┐
    ╱▏ d=-2             │                              │             d=+2 ▏╲
   ╱ ▏  d=-1            │   d = 0  焦点：正对、恒等变换   │           d=+1 ▏ ╲
  ╱  ▏  已淡出           │  最清晰、可交互、有音频          │           已淡出 ▏  ╲
        （远端沿纵深后退）│                              │      （远端沿纵深后退）
                      └──────────────────────────────┘
```

每个视图的变换由**它到焦点的序号差 `d`** 唯一决定：

```js
// ⚠️ 必须用**环绕距离**，不能直接用 i - focusIdx。
// 否则焦点在索引 0 时所有邻位 d 都为正，全部堆到右边，构图严重偏左。
let d = i - focusIndex;
const n = views.length;
if (d > n / 2) d -= n;
else if (d < -n / 2) d += n;

const ad = Math.abs(d);

el.style.transform =
  `translate3d(${d * SX}%, ${ad * SY}px, ${-ad * SZ}px) ` +
  `rotateY(${-d * RY}deg) scale(${1 - ad * SS})`;

el.style.opacity      = String(Math.max(1 - ad * 0.3, 0.22));
el.style.zIndex       = String(100 - ad);
el.style.pointerEvents = d === 0 ? "auto" : "none";
```

> 这个"堆到右边"的坑在实装第一版时就撞上了，截图对比非常明显——见 §10。

配 CSS：

```css
#stage {
  position: relative;
  overflow: hidden;
  perspective: 1700px;         /* 太小会畸变，太大没有纵深 */
  perspective-origin: 50% 46%; /* 略高于中心，像俯看展台 */
}

.pane {
  position: absolute;
  inset: 0;                    /* 所有面板同尺寸、绝对定位 → 切换零回流 */
  transform-origin: 50% 50%;
  backface-visibility: hidden;
  transition: transform 460ms cubic-bezier(.20,.85,.28,1),
              opacity   460ms cubic-bezier(.20,.85,.28,1);
  will-change: auto;           /* 仅在过渡期间切到 transform，见 §6 */
}

.pane[data-focus="1"] {
  transform: none;             /* 恒等 → 不创建多余图层、文字像素级清晰 */
}

.pane .scrim {                 /* 压暗用纯色遮罩，绝不用 backdrop-filter */
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(6,10,16,.35), rgba(6,10,16,.62));
  transition: opacity 460ms ease;
  pointer-events: none;
}
```

### 2.1 参数预设（同一套代码，换数值即可换气质）

| 预设 | `SX` | `SY` | `SZ` | `RY` | `SS` | 效果 |
|---|---|---|---|---|---|---|
| **导航优先**（默认，3D 感最强） | 46 | 3 | 190 | 30 | 0.08 | 邻位像折屏侧板，纵深明显；邻位不可读 |
| **查阅优先** | 34 | 2 | 80 | 12 | 0.04 | 焦点 + 两个邻位都还能读；3D 感较弱 |
| **全幅焦点 + 背后探头** | 58 | 6 | 240 | 34 | 0.10 | 焦点占满宽屏（社媒 UI 通常需要 ≥1024px），只从两侧露出邻位的边 |

社媒界面普遍按 ≥1024px 设计，所以**实际部署建议从"全幅焦点"起步**：
`transform: none` 的焦面板接近全宽，邻位只是从背后探出的斜边，既保留纵深暗示又不牺牲可用宽度。

### 2.2 更深处的视图

`|d| ≥ 2` 时继续按同一公式后退会迅速缩成一条线。两个选择：

- `opacity` 触底（0.22）后即可，让它们自然隐没在纵深里；
- 或对 `|d| ≥ 2` 施加 `content-visibility: hidden`（见 §6 第三档），
  并用 `contain-intrinsic-size` 避免重排，重新显示时用一次 120ms 淡入掩盖重绘。

---

## 3. 切换动画：让合合成器干活

### 3.1 推荐做法

**JS 只在状态变化时写一次 `transform` 字符串，其余交给 CSS `transition`。**
`transform` 与 `opacity` 的过渡由合成器插值，主线程不参与逐帧计算。

```js
function applyFocus(next) {
  const prev = state.focus;
  state.focus = next;

  // 过渡期间才提升为合成层，结束后撤掉 —— 避免常驻显存
  for (const v of views) v.el.style.willChange = "transform, opacity";

  for (const [i, v] of views.entries()) { /* §2 的公式 */ }

  stage.addEventListener("transitionend", () => {
    for (const v of views) v.el.style.willChange = "auto";
  }, { once: true });
}
```

### 3.2 ⚠️ 一个看起来很优雅、但不该用的写法

用 `@property` 把 `--d` 注册成 `<number>`，再用 `calc(var(--d) * 190px)` 推导 `transform`，
好处是"一个状态变量驱动全部面板、纯 CSS"。

**但自定义属性的过渡在当前 Chrome 里落在主线程**——它每帧重算计算样式，
再由主线程提交新的 `transform`，拿不到合成器动画。
对 4–6 个 1080p 图层通常还跑得动，但没有理由冒这个险。
直接把最终 `transform` 写进每个元素，反而是更快的做法。

### 3.3 摄像机微动（廉价的"3D 感"）

鼠标移动时给**一个**包裹层加极小的 `rotateX/rotateY`（≤2.5°），
或用 `perspective-origin` 跟随光标。因为它只改一个元素的一个变换，
成本几乎为零，但"立体感"提升非常明显。

必须用 `requestAnimationFrame` 节流，且 `pointer: coarse` 设备上关闭。

---

## 4. 景深线索清单（按性价比排序）

| # | 线索 | 说明 |
|---|---|---|
| 1 | **遮挡关系 + z-index** | 最强也最便宜的深度线索，浏览器免费给 |
| 2 | 侧向位移 + 绕 Y 旋转 | "折屏"的本体；旋转角度比位移更能制造体积感 |
| 3 | Z 后退 + 缩放 | 走廊纵深；`perspective` 决定畸变强度 |
| 4 | 明暗压暗（纯色遮罩） | 比模糊便宜两个数量级 |
| 5 | 焦点面板的 accent 描边/外发光 | 用 1px 边框 + 小半径 `box-shadow`，不要大面积模糊投影 |
| 6 | 面板下方的接触阴影 | 预渲染成渐变条（`background: linear-gradient`），别每帧算阴影 |
| 7 | 背景渐变/地板 | 给纵深一个参照物；纯 CSS，零成本 |
| 8 | 屏幕空间的标签浮层 | 标签**不跟着面板旋转**（旋转后的小字必糊），用同一套 `d` 计算它的位置 |
| 9 | 微弱的层次模糊 | 仅 `|d| ≥ 2` 用 1–2px，且只在过渡期间 |

---

## 5. 交互模型

| 操作 | 行为 |
|---|---|
| 点击任意可见视图（含它的遮罩） | 聚焦到它 |
| 点击焦点视图内部 | 正常操作该平台，不改变聚焦 |
| 滚轮 / 触控板横向滑动 | 前/后切换一个视图（带 200ms debounce） |
| `Ctrl/Cmd + 1..9` | 直达第 N 个视图 |
| `[` / `]` 或 `←` / `→` | 顺序切换 |
| `G` 或双击背景 | 进入/退出网格总览 |
| `Esc` | 从网格回到上一焦点 |

**关键**：非焦点面板必须 `pointer-events: none`，否则从背后探出的斜边会抢走点击。
点击由覆盖在它上面的 `.scrim` 承接（`.scrim` 自身 `pointer-events: auto`，但只在非焦点态）。

**音频随焦点走**：焦点视图取消静音，其余 `muted`。
代理视图（同源）可以直接操作 `<video>`；直连的跨源视图做不到，只能靠平台自身的静音状态。

---

## 6. 与三档节流模型的映射（DESIGN.md §7）

这是 UI 与传输策略的接缝，必须一起设计：

| 档 | UI 状态 | 渲染 | 传输 | 实现手段 |
|---|---|---|---|---|
| **A 焦点** | `d = 0`，`transform: none`，opacity 1 | 完整 | 全速 | — |
| **B 邻位** | `\|d\| = 1`，3D 侧位、压暗、`pointer-events: none` | 保持渲染（否则切回来会闪） | **降档**：静音；同源视图注入降频（暂停 `<video>`、限 rAF） | 代理视图可注入；直连跨源视图只能依赖浏览器自身节流 |
| **C 远端** | `\|d\| ≥ 2`（或网格模式下滚出视口） | `content-visibility: hidden` | 停编码 / 断开重连 | 见 §2.2 |

**必须正视的一点**：折屏布局让邻位**始终可见**，而 Chromium 只对"被遮挡/不可见"的
iframe 做自动节流。所以 B 档的降档**不能指望浏览器**，必须在应用层做：

- 代理视图（经 SW 服务，同源）：`iframe.contentDocument` 可读，直接注入节流脚本
  （暂停 `<video>`、`document.querySelectorAll('video,audio').forEach(e => e.muted = true)`）。
- 直连视图（跨源，如自建酷安 Web 版）：读不到内部，只能控制元素本身。
  此时唯一有效的手段是切到 `display: none` 或 `content-visibility: hidden` 让它彻底离开渲染树。

---

## 7. 性能纪律

### 必做

- 所有面板**恒定尺寸、绝对定位**，聚焦只改 `transform` → 零回流、站点不重排。
- 焦点态 `transform: none`（不是 `translateZ(0)`）→ 不创建常驻图层。
- `will-change` 只在过渡期间开启，`transitionend` 后撤掉。
- 过渡只用 `transform` / `opacity`，时长 380–500ms，缓动 `cubic-bezier(.2,.85,.28,1)`
  （快起慢收，像有质量）。
- 尊重 `prefers-reduced-motion: reduce` → 退化为 120ms 交叉淡入，不做 3D。
- 常驻合成层上限 ≈ 6 个 1080p 视图；更多就走"分页"而不是继续堆。

### 禁止

| 禁止 | 原因 |
|---|---|
| `backdrop-filter` 盖在 iframe 上 | 每帧回读 iframe 纹理，必然掉帧 |
| 大半径 `filter: blur()` / 大面积 `box-shadow` | 重新光栅化 + 每帧重绘 |
| 过渡 `top/left/width/height` | 触发布局与重排 |
| 用 `@property` 驱动整组 `transform` | 落回主线程（§3.2） |
| 常驻 `will-change` | 显存占用，视图多了直接崩 |
| 静止态的非整数 `scale` / 非对齐旋转 | 文字发虚 |

---

## 8. 备选布局与放弃理由

| 布局 | 形态 | 判断 |
|---|---|---|
| **折屏（推荐）** | 焦点居中正对，邻位绕 Y 内转 + 后撤 | 4–6 个视图的最优解：焦点清晰、邻位有意指、成本低 |
| 圆柱轮盘 | 视图均匀排在圆周上，整体 `rotateY` 切换 | 用一个合成变换就够，**但**相邻视图角距小的时候几乎正对着你的后背，只能看到窄边；4 个视图时两个侧位约 90° 完全不可读。视图数 ≥ 8 才值得 |
| 俯视桌面 | 全部平铺在 `rotateX(45°)` 的平面上，焦点"立起来" | 3D 感最强，**但斜置的页面根本没法读**，只能当缩略图墙。要可读就必须回到正对，等于把深度让掉了 |
| 卡片摞叠 | 全部叠在焦点后面，只露边 | 性能最省，**看不到别的视图**，与"聚合查阅"的目标直接冲突 |
| 深度走廊 | 全部沿 Z 排成一列，焦点最前 | 电影感强，但第三个之后缩成一点，浪费屏幕 |
| 双视图 | 左右各一，无 3D | 最实用但无层次感，`|d|=1` 预设其实就是它加一点纵深 |

**放弃轮盘与俯视桌面的共同原因**：它们把"深度"和"可读"变成互斥。
社媒界面需要真实宽度，所以深度只能用**过渡与边缘**来暗示，不能拿来做主要布局轴。

---

## 9. 落地顺序

| 步骤 | 内容 | 验收 |
|---|---|---|
| **U1** | 折屏布局 + 参数预设切换（无需动画调优） | 4 个视图同屏，焦点正对清晰，邻位可见；`transform: none` 生效 |
| **U2** | 过渡动画 + `will-change` 生命周期 | 切换全程 60fps；DevTools Layers 面板确认过渡后才出现图层、随后释放 |
| **U3** | 网格总览 + 两者之间的展平动画 | `G` 键往返无闪烁；网格态下真实可读 |
| **U4** | 交互补全（滚轮/键盘/scrim 点击/音频跟随） | 非焦点面板不抢点击 |
| **U5** | 三档节流接上（§6） | 非焦点视图的 GPU 占用可测量地下降 |
| **U6** | 摄像机微动 + 视觉打磨 | 关掉时无差别；开启后只用 rAF 更新一个元素 |

---

## 10. 实现记录（U1 + U2 已完成）

实装在 `proxy/public/index.html`（样式与结构）与 `proxy/public/hub.js`（布局与调度）。
用无头 Chromium 出了全套截图：`verify/shot-ui.mjs` → `verify/ui2/`。

### 实装时撞到并修掉的问题

**① 面板居中不能用 `transform`。** 焦点态要求 `transform` 严格为 `none`（否则创建常驻合成层、
文字开始重采样），所以居中只能靠 `left/top`：

```css
left: calc(50% - var(--panel-w) / 2);   /* 百分比按宽度解析 ✓ */
top:  calc(50% - var(--panel-h) / 2);   /* 百分比按高度解析 ✓ */
```

**不能用 `margin` 居中**——`margin-top` 的百分比同样按**宽度**解析，会导致纵向偏移错位。

**② 环绕距离（本文件 §2 已更新）。** 第一版直接用 `i - focusIdx`，结果焦点在索引 0 时
四个视图全堆在右边，构图偏得很明显：

| 版本 | 效果 |
|---|---|
| `d = i - focus` | 焦点面板左倾，右侧挤着三个面板，左侧全空 |
| 环绕距离取模 | 焦点居中，左右各一折翼，第四个退到远端 |

修复后 `preset-nav` 与 `focus-zhihu` 两种焦点位置都左右对称。

### 已验收

| 项 | 结果 |
|---|---|
| 焦点面板清晰度 | `transform: none` 生效，文字无重采样 |
| 三个预设 | `nav` / `read` / `full` 均正常，切换改面板宽度会重排（低频、刻意） |
| 焦点切换 | 四个焦点位置截图均左右对称、姿态正确 |
| 宫格总览 | `G` / 按钮往返正常，宫格下四视图真实可读 |
| 非焦点不抢点击 | 面板 `pointer-events: none`，遮罩单独接管点击用于聚焦 |
| 冷启动 | 折屏布局不影响既有的传输层预热与重试，4/4 加载 |

### 尚未做

- **U3** 折屏 ↔ 宫格之间的"展平"过渡（目前是瞬时切换，靠 `transition` 也能连上，但没做编排）
- **U5** 三档节流：`|d| ≥ 2` 目前只是透明度触底，还没接 `content-visibility` 与传输停编码
- **U6** 摄像机微动、标签浮层、接触阴影的视觉打磨
- 过渡期间的实际帧率与图层数尚未用 DevTools 量化

---

## 11. 控制栏与拖拽改尺寸（已实装）

### 11.1 每个视图自带一条浏览器控制栏

`后退 ‹ / 前进 › / 刷新 ⟳ / 地址栏`，放在面板内部上方。

**关键设计：这条栏的高度在**所有**面板上都常驻**。只在焦点面板上隐藏控件、显示平台名。
如果改成"焦点面板才渲染这条栏"，焦点切换就会改变 iframe 高度 → 整站重排，
正好违反 §7 的第一条纪律。

**地址栏显示的是还原后的真实网址。** 代理视图与 hub 同源，可以直接读
`iframe.contentDocument.location.href`，再用 `controller.decodeUrl()` 还原：

```js
const real = controller.decodeUrl(iframe.contentDocument.location.href);
// http://127.0.0.1:18095/scramjet/https%3A%2F%2Fwww.bilibili.com%2F  →  https://www.bilibili.com/
```

**跨源直连视图（自建酷安 Web 版）读不到 location**，所以历史栈由我们自己维护：
每次导航入栈，`load` 事件里若是同源就同步真实地址（从而把页内点链接也记进历史）。

### 11.2 拖拽改尺寸

四个角的把手，**以舞台中心为锚点**，所以拖任意一角都是对称缩放，面板自然保持居中。

**拖动期间只做 `transform: scale()`，真尺寸留到 `pointerup` 一次性提交。**
这是必须的：直接改 `width/height` 会让 iframe 里的整站在每一帧重排
（拖一次 = 上百次重排 + 上百次懒加载判定）。实测拖动中拿到的变换是
`matrix(1.33354, 0, 0, 1.19714, 0, 0)`——纯 scale，零回流；松手后回到 `none`，
焦点态恢复恒等变换、文字重新变清晰。

尺寸按视图存在 `localStorage`，预设切换**只覆盖没被手工调过的视图**；
双击把手复位到当前预设。

### 11.3 验收

| 项 | 结果 |
|---|---|
| 地址栏导航 | 输入 `zhihu.com/explore` → 标题变为「发现 - 知乎」 |
| 后退 / 前进 / 刷新 | 历史栈 `hidx` 正确回退与前进，标题随之变化 |
| URL 还原 | `https://www.bilibili.com/`、`http://127.0.0.1:17520/`（非编码路径） |
| 拖动中变换 | `matrix(1.3335, 0, 0, 1.1971, 0, 0)` —— 纯 scale |
| 松手后变换 | `none` —— 恒等，文字清晰 |
| 尺寸提交 | `60×80` → `81.5×97.1`，`custom=true` |
| 保持居中 | 是（面板中心与舞台中心偏差 < 2px） |
| 持久化 | 刷新后仍为 `81.5×97.1`，`custom=true` |

### 11.4 实装时踩的坑

**`setPreset()` 里的 `persistSizes()` 会擦掉存档。** 启动时所有视图都还不是 `custom`，
于是它把一个空对象写进 `localStorage`，正好发生在 `applyPersistedSizes()` 读取之前——
表现就是"拖完尺寸、一刷新就没了"。预设只影响非 custom 视图，本来就不需要写盘，删掉即可。

**Wisp 拒绝连接私有地址**，所以没法用局域网探针页做"经代理的拖拽"实验：

```
info: opening new TCP stream to 10.0.30.61:18096
warn: refusing to create a stream to 10.0.30.61:18096
```

这是 wisp 的防 SSRF 设计，不是缺陷（自建酷安走直连，并不需要经代理）。绕开的办法是
**直接往真实的代理页面里注入监听器**——代理页面与 hub 同源，父页面可以拿到
`contentDocument`，见 §12。

---

## 12. 知乎验证码滑块拖不动的排查（进行中）

### 12.1 已排除：代理篡改事件

往**真实的代理知乎页面**里注入监听器，然后用 CDP 派发一次人手式拖拽
（`verify/trust-check.mjs`），页面里 JS 收到的是：

| 事件 | 次数 | `isTrusted` |
|---|---|---|
| pointerdown / mousedown | 1 / 1 | `true` |
| pointermove / mousemove | 21 / 21 | `true` |
| pointerup / mouseup / click | 1 / 1 / 1 | `true` |

坐标也正确：按下 (504, 265) → 抬起 (684, 325)。

**结论：Scramjet 没有重新派发事件，"`isTrusted=false` 导致风控拒绝"这个假设不成立。**
这也顺带否掉了"折屏布局的 transform 干扰了坐标映射"——焦点面板是恒等变换，
坐标完全对得上。

### 12.2 剩下的怀疑（按可能性排序）

1. **第三方风控组件的 origin 假设。** 知乎用的是**网易易盾**（早期日志里能看到
   `cstaticdun.126.net`，滑块文案「按住左边按钮拖动完成上方拼图」也是易盾的措辞）。
   这类组件通常以**跨源 iframe + `postMessage`** 工作，并且会校验 `event.origin`。
   经代理后 origin 变成 hub 的地址，握手可能被对端拒绝——表现正是"滑块能拖，但永远验证不过"。
2. **验证请求本身失败。** 拖完要把轨迹 POST 到验证端点；若该请求在重写下出错，同样永远不过。
3. **轨迹评分。** 服务端对轨迹做行为判定。真人手拖通常能过，但这条无法在这里复现。

### 12.3 需要用户确认的一件事

症状到底是哪一种——这直接决定往哪查：

- **A. 滑块完全拖不动**（按下去没反应）→ 事件根本没到滑块，查 DOM 层级与遮罩
- **B. 滑块能动，松手后弹回/提示验证失败** → 是 12.2 的 1 或 2，属于第三方组件在代理下的兼容问题
- **C. 滑块能动，但转圈不结束** → 验证请求发不出去或被挂起

复现需要真实手机号，我**不会**去触发短信（会给陌生人发短信），所以这一条必须你来点。

### 12.4 症状确认（用户反馈）

**是 C：滑块能动，但一直转圈。** 说明拖拽事件链路正常（与 §12.1 的实测一致），
卡在**拖完之后的验证环节**——要么验证请求发不出去，要么响应回不来。

下一步需要你在真实浏览器里打开 DevTools → Network，重现一次，然后看：
- 有没有一条**一直 pending** 的请求？它的完整 URL 是什么？
- 有没有请求返回 4xx/5xx 或 `(failed)`？
- Console 里有没有跨源 / CSP / CORS 报错？

有了那条 URL 就能定位是传输层、重写层还是风控层的问题。

---

## 13. 第二轮需求：七项的落地情况

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| 1 | 地址栏不显示当前网址 | ✅ 已修 | 根因：**单页应用内部跳转不触发 iframe 的 `load` 事件**，地址栏停在旧值。改为 900ms 轮询 `contentDocument.location.href` + `decodeUrl` 还原，并顺带重新注入拦截器 |
| 2 | 重启后登录态丢失 | ✅ 已修 | 见下方 §13.1 |
| 3 | 只保留右下角手柄、改成圆角 | ✅ 已做 | 四角改单角（面板以中心为锚点缩放，四角本就等价）；把手弧线与面板 12px 圆角同心 |
| 4 | 主题色改成包边 border | ✅ 已做 | `border-top` → `border: 2px solid var(--accent)` |
| 5 | 知乎扫码后重定向太多次 | ✅ 大概率已修 | 与 #2 同根因：#2 修好后凭据能正常带上，重定向链自然闭合。**需要你复测确认** |
| 6 | 滑块能拖但一直转圈 | ⏳ 待定位 | 症状已确认是 C，见 §12.4，需要 DevTools 里那条 pending 请求的 URL |
| 7 | 拦截 `target=_blank`，在视图内弹层打开 | ✅ 已做 | 见 §13.2 |

### 13.1 #2 的根因与修法（本轮最有价值的发现）

Scramjet 的 `ScramjetServiceWorker` 在构造函数里用一个**游离的** async IIFE 读 IndexedDB：

```js
constructor(){ super(), this.client=...,
  (async()=>{ let e=await P2("$scramjet",1), t=await e.get("cookies","cookies");
              t && this.cookieStore.load(t) })(),        // ← 没人 await
  addEventListener("message", ...) }
```

`cookieStore` 是**每个 SW 实例一份的内存 jar**，而浏览器随时会回收空闲 SW。回收后
第一批请求可能赶在罐子装载完之前发出 —— 服务器收不到凭据，当成全新会话重新下发整套
cookie。这同时解释了 **#2（登录态丢失）** 和 **#5（重定向死循环）**。

**实测证据**（`verify/cookie-check.mjs`，杀掉 SW 再刷新）：

| | 修复前 | 修复后 |
|---|---|---|
| `_zap` / `_xsrf` / `BEC` | 三个值**全部轮换** | **保持不变** |
| 手动写入的探针 cookie | 消失 | **存活** |

**修法**：`sw.js` 是我们自己的文件，所以在 SW 内部自己读一次 IndexedDB 灌进同一个
`cookieStore`，并让 fetch 处理器 `await` 这个 Promise：

```js
const jarReady = (async () => { /* 读 $scramjet/cookies，逐条 setCookies */ })();

self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    await jarReady;                    // ← 关键：先等罐子装载完
    await scramjet.loadConfig();
    ...
  })());
});
```

页面侧也加了一层回填（`hub.js` 的 `rehydrateCookies`）作为兜底，但**单独用它不够**
——实测无效，真正的修复在 SW 侧。另外这一层最初把 cookie **对象**推给了 SW，
而 `setCookies()` 要的是 `Set-Cookie` **字符串**，于是往罐子里写进了
`undefined=undefined` 的垃圾条目；已改成拼字符串。

### 13.2 #7 视图内弹层

代理视图与 hub 同源，所以可以直接往 iframe 里注入：

- 捕获阶段拦 `a[target=_blank]` / `a[target=_new]` 的点击 → `preventDefault()` + 开弹层
- 覆写 `iframe.contentWindow.open` → 同样进弹层
- 文档被整页替换后要重新注入，所以挂在 900ms 的轮询里

弹层与主视图**同尺寸**，主视图 `scale(1.045)` 向四周扩张 + 半透明遮罩压暗其层级，
弹层自身从 `scale(0.965)` 淡入。`Esc` 或点遮罩关闭；被压层级的主视图会隐藏自己的
控制栏，避免和弹层的控制栏叠成两条。

**实测**（`verify/overlay-check.mjs`，哔哩哔哩首页 85 个 `target=_blank` 链接）：
点击 → 弹层打开 `https://www.bilibili.com/anime/`，标题「番剧 - 哔哩哔哩」，
主视图 `under=1`，`Esc` 关闭。跨源直连的自建酷安注入不进去，只能放行成新标签页。

---

## 14. 第三轮：快捷键与设置

| 需求 | 状态 | 说明 |
|---|---|---|
| `Ctrl+R` 刷新焦点视图 | ✅ 已做并实测 | 见 §14.1 |
| `Ctrl+Shift+R` 刷新整个页面 | ✅ 已做 | 同样是劫持后改调 `location.reload()` |
| 酷安默认地址改为 `…:17520/#/` | ✅ 已做 | 保留 `{host}` 占位符，理由见 §14.2 |
| 顶栏设置按钮 + 站点列表弹窗 | ✅ 已做并实测 | 见 §14.3 |

### 14.1 Ctrl+R 要绑两处

**焦点在视图内部时，键盘事件不会冒泡到 hub**，所以只绑 hub 的 `window` 是不够的。
除了 hub 自己的监听，还要往每个代理视图的 document 里注入一份（挂在已有的
900ms 轮询里，文档被整页替换后会自动重绑）。

实测（`verify/key-check.mjs`）：给 iframe 打标记 ——

| 场景 | 标记 | 结果 |
|---|---|---|
| hub 里按 Ctrl+R | `__MARK=42` | `undefined`（视图已重载）✓ |
| 视图内按 Ctrl+R | `__MARK2=7` | `undefined` ✓ |

### 14.2 酷安地址为什么保留 `{host}`

用户要求写死 `http://10.0.30.61:17520/#/`。这里改成了
`http://{host}:17520/#/` + `https://{host}:17521/#/`，`{host}` 在运行时替换成
**你打开 hub 的那个主机名**。

原因是它的会话 Cookie 是 `SameSite=Strict`：如果你从 `127.0.0.1:18095` 打开 hub，
而 iframe 指向 `10.0.30.61:17520`，那就是**跨站**，Cookie 不会发送，应用会报
「缺少或无效的会话 token」。用 `{host}` 才能保证两者始终同站。

### 14.3 设置弹窗

`localStorage.zoetrope.sites` 覆盖 `platforms.js` 里的默认列表；
保存后直接 `location.reload()` —— 站点列表变化意味着所有 frame 都要重建，
重载比增量重建可靠得多，也不必处理各种中间态。

表单里没有的字段（`accent`、`urlTemplateHttps`）从原对象拷贝保留；
`urlTemplateHttps` 在地址仍匹配 `:17520` 时按 `http→https` / `17520→17521` 推导。

实测（`verify/settings-check.mjs`）：弹窗打开显示 4 行、字段正确；把第一行改名为
「B站」、再加一行「测试站 → https://example.com/」，保存后重载，
`window.PLATFORMS` 变成 5 项且改动生效。

---

## 15. 仍未解决

### 15.1 知乎扫码登录后仍然 ERR_TOO_MANY_REDIRECTS

§13.1 的 SW cookie 修复解决了哔哩哔哩，但**知乎扫码登录仍然死循环**。

推测：**3xx 重定向响应上的 `Set-Cookie` 没进 cookie 罐**。Scramjet 的罐更新依赖
客户端读 `document.cookie` 再回传，而重定向过程中没有文档，也就没人回传 ——
于是登录票据丢了、服务器一直把请求跳回登录页。这条要验证，需要在 SW 里包裹
`scramjet.fetch`，从响应头里自己解析 `Set-Cookie` 塞进罐子。

**需要你提供**：重现时 DevTools → Network 里，那条反复出现的请求是哪个 URL、
以及它每次的响应码与 `Set-Cookie`。

### 15.2 抖音加载不出来

无头环境实测（**当前代码**）仍然只是落到「验证码中间页」（79 个节点），
**不是第三轮改动引入的回归**。抖音的风险控制在代理链路上一直拦着（见 DESIGN.md §14.9
关于传输层指纹的判断）。

**需要你确认**：你在真实浏览器里看到的是**一片空白**，还是**停在验证码页**？
两者指向完全不同的方向。

### 15.3 其他

- **U3** 折屏 ↔ 宫格的展平过渡编排
- **U5** 三档节流（`|d| ≥ 2` 接 `content-visibility` 与传输停编码）
- **U6** 摄像机微动、屏幕空间标签浮层、接触阴影
- 过渡期间的真实帧率与图层数（需真机 DevTools 量化）

---

## 16. 第四轮：弹层里放视频（根因 + 修复）

用户反馈：**B 站视频在单独标签页里走反代 URL 能正常播，但没法用"弹出子视图"的方式看。**

排查结论：**视频本身没问题，是弹层的地址被我们自己写坏了。**

### 16.1 根因：`decodeUrl` 被喂了不该喂的地址

`hub.js` 的 `toRealUrl()` 原本无条件调用 Scramjet 的 `decodeUrl`：

```js
const d = controller.decodeUrl(u);
if (d && d !== u) return d;   // ← 灾难在这里
```

而 Scramjet 的实现是**无条件切片**（`scramjet.all.js`，`ScramjetController.decodeUrl`）：

```js
decodeUrl(e) {
  e instanceof URL && (e = e.toString());
  let t = location.origin + n.$W.prefix;      // "http://localhost:18095/scramjet/"，34 字符
  return (0, n.P_)(e.slice(t.length));        // 不管 e 有没有前缀，照切 34 个字符
}
```

给一个**没经过代理**的普通网址（B 站首页的视频卡 `href` 就是原样的
`https://www.bilibili.com/video/BV1ZDan66EdQ/`），它会切掉前 34 个字符，
把剩下的碎片 `"BV1ZDan66EdQ/"` 当编码串解码 → 得到一个垃圾结果 `about:blank`。

**这个 bug 是 URL 长度相关的**，所以表现得像随机：

| 链接 | 长度 | `slice(34)` | 结果 |
|---|---|---|---|
| `https://www.bilibili.com/anime/` | 32 | `""` | 空串被当假值 → 走兜底分支 → **正常** |
| `https://www.bilibili.com/video/BV1ZDan66EdQ/` | 41 | `"BV1ZDan66EdQ/"` | 垃圾值 → **弹层地址变成 `about:blank`** |

于是「点番剧能弹层、点视频弹个空白页」——看起来毫无规律。

**修法**（`toRealUrl` / `isProxiedUrl`）：先判断地址确实以
`location.origin + "/scramjet/"` 开头才去 `decodeUrl`，并且只接受解码结果中
形如 `http(s)://` 的值。

### 16.2 顺带补齐的三件事

1. **`⧉` 按钮**：每个视图的控制栏加一个「在弹层中打开当前页」。不依赖站点的链接写法，
   是最可靠的入口 —— 想让哪个页面进子视图就按哪个。
2. **修饰键点击 / 中键点击**：按住 `⌥`/`Ctrl`/`⌘` 点站内任意链接（或中键点）→ 进弹层。
   这是"在新标签页打开"的肌肉记忆，正好对上用户想要的心智。
3. **弹层导航看门狗**：新建的 Scramjet frame **第一次**导航偶发卡死在
   `readyState=loading`（文档已提交、零子资源、永不解析，实测 4 次里中 1 次）。
   主视图早就有 `goWithRetry` 兜底，弹层原先没有。现在按
   「loading + 无标题 + body 空 + 零资源」这个**很窄的特征**判定卡死，6 秒后重发导航，
   最多 3 次；正常慢加载的站点不会命中这四条。

另外两处顺带修的：

- `#overlay` 的控制栏原本没有样式 —— 样式规则全部写成 `.pane .chrome …`，
  弹层的按钮/地址栏退化成浏览器默认外观。现在控制栏样式挂在共用的 `.chrome` 上。
- `closeOverlay()` 会暂停弹层里的 `<video>`。否则关掉弹层后视频留在隐藏 iframe 里
  继续放，用户只听见声音、找不到来源。

4. **弹层自己也要被拦截**：弹层里的 `target=_blank` 链接（比如 B 站视频页的
   "接下来播放"卡片）原本会弹出**真的新浏览器标签页**，直接破坏"一个页面装下所有内容"
   这个前提。现在弹层文档也走同一套 `injectInterceptor`，链接**原地换页**。
   实现上给弹层造了一个伪视图（`OVERLAY_ID = "__overlay__"`），
   并且 `openFrom()` 要把它映射回 `state.overlayFrom` ——
   否则 `under` 标记会被清空，压暗层次突然消失。

### 16.3 验收（`verify/links-probe.mjs` + `verify/overlay-shot.mjs`）

在 B 站首页点第一张视频卡（24 个视频卡全部是 `target=_blank`）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 弹层地址栏 | `about:blank` | `https://www.bilibili.com/video/BV1ZDan66EdQ/` |
| 弹层文档 | 空 | 标题「【如愿】23组来自大江南北的AI歌手共唱…」 |
| 弹层 `readyState` | 空文档 | `complete` |
| 弹层内 `<video>` | 无 | `readyState=4`（HAVE_ENOUGH_DATA）、`duration=257s`、`currentTime` 持续增长、`videoWidth=640`、`error=null` |
| 分片请求 | — | `mcdn.bilivideo.cn` 分片 `206 × 35` |

`__ZOETROPE.overlayLog` 留下了调用流水，之后同类问题可以一次看穿是"谁调的、
原始参数是什么、还原成了什么"。

三个入口的验收（`verify/round4-check.mjs`）：

| 入口 | 结果 |
|---|---|
| ① 控制栏 `⧉` 按钮存在 | ✅ |
| ② 点 `⧉` | 弹层打开 `https://www.bilibili.com/video/BV1ZDan66EdQ/` |
| ③ 弹层里的 `<video>` | `readyState=4`、`currentTime=7.4s` 且推进、`paused=false` |
| ④ `Esc` 关闭 | `overlay=0`，且视频 **`paused=true`**（声音被掐掉） |
| ⑤ `Ctrl`+点击站内链接 | 弹层打开「番剧」页；主视图 URL 不变 |

弹层内部再点 `target=_blank` 链接（`verify/ovl-click-check.mjs`，视频页里有 91 个）：
弹层原地从视频页换到番剧页，`under` 标记仍是 `bilibili:1`，
**浏览器标签页数 `before=1 after=1`** —— 没有再弹真的新标签页。

> 附注（**已更正**）：当初把截图里弹层的"发虚重影"归因成 B 站登录弹窗的
> `backdrop-filter`，**那是错的**。真因见 §17.1 —— 面板的 z-index 高于弹层，
> 弹层被压在下面，而"被压层级"的面板自身 `opacity: 0.72`，于是首页与视频页
> 叠在一起，看起来像重影。修掉层级后重影消失，`verify/round4/popout-open.png`
> 里能看到清晰的播放器、弹幕与"114 人正在看"。



---

## 17. 第四轮：弹层层级、性能，以及 U3 / U5 / U6

### 17.1 弹层"半透明"的根因：z-index 层级倒挂

用户反馈"弹层是半透明的，页面部分必须完全不透明"。先别猜，做像素判定
（`verify/overlay-alpha-check.mjs`）：

1. 打开弹层，按弹层矩形裁一张图；
2. 注入 `#veil{display:none} .pane{visibility:hidden}` 把弹层背后全藏掉，再裁同一块；
3. 逐像素 diff。

**修复前**：`[10,380]` 处 有底层 `(194,188,183)` / 无底层 `(255,255,255)` —— 底层确实透上来了。

根因在 `applyLayout()`：

```js
v.pane.style.zIndex = String(100 - ad);   // 面板 100 / 99 / 98 …
```

而 `#veil` 是 `z-index: 40`、`#overlay` 是 `z-index: 41`。
**弹层其实一直被压在面板下面**，只是因为被压层级的那个面板自己是
`.pane[data-under="1"] { opacity: 0.72 }`，透出 28% 的弹层内容，
视觉上就成了"弹层半透明"。同一个 bug 还让 `#veil` 从来没压暗过任何面板。

修法是把层级关系写成契约，并在 CSS 里注明：

| 层 | z-index |
|---|---|
| 面板（焦点 / 邻位） | `20` / `10 - \|d\|` |
| `#veil` 遮罩 | 30 |
| `#overlay` 弹层 | 31 |
| `#labels` 屏幕空间标签 | 35 |
| `#boot` 启动遮罩 | 50 |
| 设置弹窗 | 60 |

**修复后**：逐像素 diff **166 / 766080（0.022%）**，最大通道差 24，且全部落在
弹层外圈圆角抗锯齿的那 1px 边上。内部区域 100% 一致 —— 弹层已经是完全不透明的。

> 顺带一个副作用：`#overlay` 与"被压层级的焦点面板"现在矩形完全重合
> （以前面板带 `transform: scale(1.045) !important` 会从弹层四周露出来）。
> 那个 `!important` 同时挡住了 U3 的 FLIP，所以一并去掉；层次感改由 `#veil` 承担。

### 17.2 性能：先量，再改

"和原生标签页完全不一致"必须先量化。第一版量法踩了两个坑：
等了 45 秒 `navigator.serviceWorker.controller`（首屏页面本来就**不在** SW 控制之下，
新建的 iframe 才在），以及把 CDP 连接建立时间算进了导航时间。

正确量法（`verify/perf-check.mjs`）：时间基准取**各自文档内部的 `performance.now()`**。

**基线（改之前）**，单位 ms：

| 站点 | interactive | complete |
|---|---|---|
| bilibili | 392 | 7725 |
| zhihu | 389 | 9991 |
| douyin | 3064 | 3064 |

时间花在哪，`__ZOETROPE.timing()` 说得很清楚：启动开销（注册 SW + 连 Wisp +
回填 cookie + 预热传输层）**只有 88 ms**，剩下的全是**四个平台同时开抢**：

- 四路流量挤在**同一条** Wisp WebSocket 上，互相排队；
- 四个同源 iframe 在**同一个渲染进程**里（原生浏览器是每站一个进程），
  首屏 JS 的执行互相抢主线程。

**改法：按「到焦点的环绕距离」分三批放行**（`bootNavigateOrdered`）——
焦点视图立刻走，邻位在焦点 `load` 后（2.5s 兜底）走，远端再等 1.5s（8s 兜底）。

**优化后**：

| 站点 | 基线 complete | 优化后 complete | 提速 |
|---|---|---|---|
| bilibili | 7725 | 3846 | **2.01×** |
| zhihu | 9991 | 6066 | 1.65× |
| douyin | 3064 | 2304 | 1.33× |

优化后 `__ZOETROPE.timing()`：`main 0 / sw 38 / transport 84 / cookies 85 / warm 88 /
start:bilibili 105 / start:zhihu 2647 / start:douyin 5426 / load:bilibili 3883 /
load:zhihu 8405 / __totalMs 8405`。

### 17.3 U5：三档节流

| 档 | 条件 | 行为 |
|---|---|---|
| A | 焦点 | 恒等变换、可交互、完整渲染 |
| B | `\|d\| = 1` | 3D 侧位、压暗、遮罩接管点击 |
| C | `\|d\| ≥ 2` | 退到视觉之外；`.frame` 挂 `content-visibility: hidden` 停渲染；**暂停里面的音视频** |

两个实现细节：

- 停渲染加在 **`.frame`** 而不是 `.clip`：包边、圆角、底色还在，
  远端是一块"退到暗处的板"，而不是凭空消失的洞；省掉的正是最贵的 iframe 绘制。
- 暂停不能只在切档那一刻做一次 —— 站点可能**稍后**才自动播放。
  900ms 的轮询里对 C 档面板兜一次（`pauseMediaIn`），否则用户会听见看不见的声音。

实测（`verify/round5-check.mjs`）：焦点 bilibili=A、zhihu=B、douyin=C、coolapk=B；
douyin 的 `.frame` 计算值 `content-visibility: hidden`。

### 17.4 U3：折屏 ↔ 宫格的展平编排

用 **FLIP**：量折叠态矩形 → 切布局 → 量宫格态矩形 → 把面板用内联 transform
放回折叠态 → 下一帧清掉，它就自己"展平"过去。反向（宫格 → 折屏）同理，
看起来像把摊开的纸重新折起来。

为此必须去掉宫格规则里的 `transform: none !important` / `opacity: 1 !important`，
否则内联 transform 永远被压掉、动画完全不发生。

实测：切到宫格后连续采样 14 帧，bilibili 的矩形轨迹是
`[336,145,1008,760] → … → [109,86,881,551] → [10,61,825,460]`，
中间确实有插值帧（`verify/round5/flip-mid.png` 是动画进行中的抓帧）。

### 17.5 U6：摄像机微动 / 屏幕空间标签 / 接触阴影

**摄像机微动**：`pointermove` 只写 `#stage` 上的两个自定义属性
`--camx/--camy`（`perspective-origin` 消费它们）。不触发重排，3D 场景的投影矩阵
在合成器上更新；rAF 节流 + 0.04% 死区。实测 `["0%","0%"] → ["-0.91%","-0.62%"]`；
`prefers-reduced-motion: reduce` 时完全不绑定。

**屏幕空间标签**：面板被 `rotateY + scale` 变换过，面板**内部**的文字会被重新采样
变糊，所以标签挂在 `#labels`（不参与 3D 变换）里，用与 CSS 完全一致的投影公式
定位：

```
P' = O + (P - O) · d / (d − z)      d = 1700px，O = perspective-origin
```

transform 列表是 `translate3d → rotateY → scale`，起点是中心，
所以旋转与缩放不改变中心，只有 `translate3d` 会移动它。
标签只在**过渡结束**后淡入，不做逐帧跟随，免得每帧强制样式刷新。

实测：三个非焦点面板的标签中心都落在各自面板的投影范围内（`inside: true`），
且因为透视，标签中心相对面板中心是按 `k = 1700/(1700 − z)` 往里收的
（zhihu 面板中心 1593 → 标签 1544）。

**接触阴影**：`.pane .shadow` 用纯径向渐变（**不用 `filter: blur()`**，
模糊是每帧回读），DOM 上排在 `.clip` **之前**，靠文档序压在面板下方 ——
不能用负 `z-index`，因为焦点态 `.pane` 不是层叠上下文，负值会掉到 `#stage` 背景后面。
实测：焦点面板 `opacity: 1`、非焦点 `0`。

### 17.6 顺手修掉的：跨源直连视图的地址栏显示 `about:blank`

酷安的视图是 `proxied: false`（跨源直连，读不到 `contentDocument`），但它的地址栏
一直显示 `about:blank`。原因不在酷安：**iframe 刚被 `append`、还没开始导航的那一瞬间，
`contentDocument` 是*同源*的 `about:blank`** —— 900ms 的轮询正好在这个窗口里读到它，
当成真实网址塞进了历史栈。

修法：`realUrlOf` 拆出 `realUrlOfEl(el)`，只接受 `http(s)` 开头的结果。

修后四个视图的地址栏：

| 视图 | 地址栏 |
|---|---|
| bilibili | `https://www.bilibili.com/` |
| zhihu | `https://www.zhihu.com/signin?next=%2F` |
| douyin | `https://www.douyin.com/` |
| coolapk | `http://localhost:17520/#/`（原来是 `about:blank`）|

验证脚本：`verify/coolapk-addr-check.mjs`。

### 17.7 回归

| 检查 | 结果 |
|---|---|
| 弹层不透明度（逐像素） | 差异 0.022%，仅圆角 1px 边 ✅ |
| 弹层播放视频（`round4-check`） | `readyState=4`、`currentTime` 推进、`paused=false` ✅ |
| `Esc` 关闭弹层 | `overlay=0` 且视频 `paused=true` ✅ |
| `⧉` / `Ctrl+点击` 进弹层 | 地址与标题正确，主视图不被带走 ✅ |
| 窄屏性能（焦点优先） | bilibili complete 7.7s → 3.8s ✅ |
