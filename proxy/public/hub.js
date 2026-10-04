"use strict";

/**
 * zoetrope —— 多视图调度（折屏布局）
 *
 * 每个平台 = 一个 Scramjet frame（独立 iframe，由同一个 Service Worker 服务）。
 *
 * 布局：焦点面板正对镜头（transform 严格为 none），左右邻位绕 Y 轴内转 + 后撤 + 压暗，
 * 更远的沿纵深继续后退并淡出。每个面板的变换只由「它到焦点的序号差 d」决定。
 *
 * 性能纪律（详见 UI.md）：
 *   - 过渡只碰 transform / opacity，两者都在合成器上跑，主线程零逐帧工作
 *   - 面板恒定尺寸 + 绝对定位，聚焦切换**绝不改尺寸**，因此零回流、站点不重排
 *   - will-change 只在过渡期间开启
 *   - 压暗用纯色遮罩，不用 backdrop-filter
 *
 * 节流三档（对应 DESIGN.md §7）：
 *   A 焦点     d = 0      恒等变换、可交互、音频开、完整渲染
 *   B 邻位     |d| = 1    3D 侧位、压暗、不接指针（遮罩接管点击）
 *   C 远端     |d| ≥ 2    继续后退、透明度触底（下一步接 content-visibility 停渲染）
 */

/* ------------------------------------------------------------ 参数预设 */

const PRESETS = {
	// 导航优先：3D 感最强，邻位像折屏侧板；邻位不可读
	nav: { panelW: "60%", panelH: "80%", sx: 78, sy: 6, sz: 200, ry: 28, ss: 0.1, dim: 0.62, minOp: 0.2 },
	// 查阅优先：焦点 + 两个邻位都还能读，3D 感较弱
	read: { panelW: "72%", panelH: "84%", sx: 50, sy: 3, sz: 90, ry: 14, ss: 0.05, dim: 0.48, minOp: 0.3 },
	// 全幅焦点：焦点几乎占满（社媒 UI 多按 ≥1024px 设计），邻位只从两侧露边
	full: { panelW: "94%", panelH: "88%", sx: 88, sy: 8, sz: 250, ry: 33, ss: 0.11, dim: 0.68, minOp: 0.16 },
};

const DUR_MS = 460;

const state = {
	ready: false,
	error: null,
	focus: null,
	mode: "focus", // focus | grid
	preset: "nav",
	views: {},
};

/* --------------------------------------------------------------- 对外 API */

window.__ZOETROPE = {
	get ready() { return state.ready; },
	get error() { return state.error; },
	get focus() { return state.focus; },
	get mode() { return state.mode; },
	get preset() { return state.preset; },
	setMode,
	focusView,
	setPreset,
	/** 弹层（子视图）：供自动化与调试使用 */
	openOverlay,
	closeOverlay,
	/** 弹层调用流水，排查"弹层开了但是空白页"用 */
	get overlayLog() { return overlayLog.slice(); },
	/** 启动分段计时（ms，以 main() 开始为 0） */
	timing() {
		const base = T.main || 0;
		const out = {};
		for (const [k, v] of Object.entries(T)) out[k] = Math.round(v - base);
		const last = Math.max(0, ...[...Object.values(T)]);
		out.__totalMs = Math.round(last - base);
		return out;
	},
	/** 把代理地址还原成真实网址（会自动判断是不是代理地址） */
	decode: toRealUrl,
	/** 把真实网址编码成走代理的地址（favicon 那类由 hub 自己发起的请求要用） */
	encode: (u) => outboundUrl(u, { mode: "proxied" }),
	isProxiedUrl,
	/** 直接往某个视图里导航，绕过地址栏模拟 */
	go(id, url) {
		const v = state.views[id];
		if (!v) return null;
		navigate(v, url);
		return v.hist[v.hidx];
	},
	/** 滚动/键盘切换之外的直接操作，供自动化与调试使用 */
	next(delta) {
		const ids = Object.keys(state.views);
		const i = ids.indexOf(state.focus);
		focusView(ids[(i + delta + ids.length) % ids.length]);
	},
	/** 读取各视图的历史栈状态 */
	nav(id, act) {
		const v = state.views[id];
		if (!v) return null;
		if (act === "back") v.btns.back.click();
		else if (act === "forward") v.btns.forward.click();
		else if (act === "reload") v.btns.reload.click();
		return { url: v.hist[v.hidx], hidx: v.hidx, len: v.hist.length };
	},
	urls() {
		const o = {};
		for (const [id, v] of Object.entries(state.views)) o[id] = v.hist[v.hidx];
		return o;
	},
	/** 尺寸（舞台百分比）读写，供自动化与调试使用 */
	sizes() {
		const o = {};
		for (const [id, v] of Object.entries(state.views)) {
			o[id] = { ...(v.size || presetSize(state.preset)), custom: v.custom };
		}
		return o;
	},
	setSize(id, w, h) {
		const v = state.views[id];
		if (!v) return null;
		v.size = { w, h };
		v.custom = true;
		applySize(v);
		persistSizes();
		return v.size;
	},
	resetSize,
	/** 逐视图探测：能读到多少真实内容（同源，因为都经 SW 从本域服务） */
	probe() {
		const out = {};
		for (const [id, v] of Object.entries(state.views)) {
			const rec = {
				state: v.state,
				mode: v.mode,
				requestedUrl: v.url,
				title: null,
				nodes: null,
				text: null,
				probeError: null,
			};
			try {
				const d = v.el.contentDocument;
				if (d) {
					rec.title = d.title || null;
					rec.nodes = d.querySelectorAll("*").length;
					rec.text = (d.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300);
					rec.frameUrl = d.location.href;
				} else if (v.mode === "direct") {
					// 跨源直接 iframe：无法读取内部，只能确认它已经加载完成
					rec.probeError = "cross-origin（direct 模式本就不可读，属正常）";
				}
			} catch (e) {
				rec.probeError = String(e);
			}
			out[id] = rec;
		}
		return out;
	},
};

const stage = document.getElementById("stage");
const labelsEl = document.getElementById("labels");
const tabsEl = document.getElementById("tabs");
const statEl = document.getElementById("stat");
const bootEl = document.getElementById("boot");
const bootErrEl = document.getElementById("boot-error");

function setStat(text) {
	statEl.textContent = text;
}

/**
 * 启动分段计时。用户说"和原生标签页完全不一致"，那就必须能说清
 * 时间花在哪一段，而不是靠感觉。`__ZOETROPE.timing()` 取。
 */
const T = Object.create(null);
function tMark(name) {
	if (!(name in T)) T[name] = performance.now();
}

function bootFail(err) {
	state.error = String(err);
	bootErrEl.textContent = String(err);
	setStat("启动失败");
	console.error("[zoetrope]", err);
}

/* ----------------------------------------------------------- 折屏布局核心 */

/* ── 层级常量（与 index.html 的"层级契约"保持一致）───────────────
   面板必须是**低** z-index：弹层在 31、遮罩在 30。
   曾经面板写 100/99/98…，直接把弹层压到下面去了。 */
const Z_FOCUS = 20;
const zFor = (ad) => String(Math.max(1, 10 - ad));

let willChangeTimer = null;
let flipTimer = null;

/** 过渡期间才把面板提升为合成层，结束后立刻撤掉，避免常驻显存 */
function markTransitioning() {
	for (const v of Object.values(state.views)) v.pane.style.willChange = "transform, opacity";
	clearTimeout(willChangeTimer);
	willChangeTimer = setTimeout(() => {
		for (const v of Object.values(state.views)) v.pane.style.willChange = "auto";
		// 过渡结束才把屏幕空间标签摆到最终位置并淡入（避免逐帧跟随 3D 投影）
		positionLabels({ show: true });
	}, DUR_MS + 90);
}

/* ─────────────────────────── U5：三档节流 ───────────────────────────
   A 焦点 | B 邻位 | C 远端。
   C 档已经退到视觉之外，继续让它绘制纯属浪费：
   `.clip` 上挂 content-visibility: hidden（跳过绘制与布局、保留 iframe 状态），
   同时把里面正在播放的媒体暂停 —— 否则用户会听见看不见的视频在响。 */

function pauseMediaIn(el) {
	try {
		const d = el && el.contentDocument;
		if (!d) return;
		for (const m of d.querySelectorAll("video, audio")) {
			try {
				if (!m.paused) m.pause();
			} catch {}
		}
	} catch {}
}

function applyTier(v, tier) {
	const far = tier === "C";
	v.pane.dataset.tier = tier;
	// 停渲染只加在 .frame 上，不加在 .clip 上：
	// 这样面板的包边、圆角与底色还在，远端是一块"退到暗处的板"，
	// 而不是凭空消失的洞。省掉的正是最贵的部分 —— iframe 的绘制。
	if (v.frameBox) v.frameBox.style.contentVisibility = far ? "hidden" : "";
	if (far) pauseMediaIn(v.el);
}

/* ─────────────────────────── U6：屏幕空间标签 ───────────────────────
   面板被 rotateY + scale 变换过，面板**内部**的文字会被重新采样。
   标签放在 #labels 里，用与 CSS 完全一致的投影公式算屏幕坐标：

     P' = O + (P - O) * d/(d - z)     d = perspective 距离，O = perspective-origin

   transform 列表 translate3d → rotateY → scale，起点是中心，所以旋转与缩放
   不改变中心，只有 translate3d 会移动它。 */

const PERSPECTIVE_PX = 1700;
const PERSPECTIVE_ORIGIN = { x: 0.5, y: 0.46 }; // 与 CSS 的 50% 46% 对应

function positionLabels({ show = false } = {}) {
	const sr = stage.getBoundingClientRect();
	if (!sr.width || !sr.height) return;
	const ox = sr.width * PERSPECTIVE_ORIGIN.x;
	const oy = sr.height * PERSPECTIVE_ORIGIN.y;
	for (const [id, v] of Object.entries(state.views)) {
		const lab = v.label;
		if (!lab) continue;
		const tf = v.tf;
		if (state.mode !== "focus" || id === state.focus || !tf) {
			lab.dataset.on = "0";
			continue;
		}
		const z = tf.dz;
		const k = PERSPECTIVE_PX / (PERSPECTIVE_PX - z);
		const cx = sr.width / 2 + tf.dx;
		const cy = sr.height / 2 + tf.dy;
		const px = ox + (cx - ox) * k;
		const py = oy + (cy - oy) * k;
		lab.style.left = px.toFixed(1) + "px";
		lab.style.top = py.toFixed(1) + "px";
		lab.dataset.on = show ? "1" : "0";
	}
}

/* ─────────────────────────── U6：摄像机微动 ─────────────────────────
   只改 perspective-origin 两个自定义属性：不触发重排，3D 场景的投影矩阵
   在合成器上更新。rAF 节流 + 死区，鼠标抖一下不会把主线程搅乱。 */

let camRaf = 0;
let camWant = { x: 0, y: 0 };
let camNow = { x: 0, y: 0 };

function flushCam() {
	camRaf = 0;
	if (Math.abs(camWant.x - camNow.x) < 0.04 && Math.abs(camWant.y - camNow.y) < 0.04) return;
	camNow = { ...camWant };
	stage.style.setProperty("--camx", camNow.x.toFixed(2) + "%");
	stage.style.setProperty("--camy", camNow.y.toFixed(2) + "%");
}

function bindCamera() {
	if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	stage.addEventListener(
		"pointermove",
		(e) => {
			const r = stage.getBoundingClientRect();
			if (!r.width || !r.height) return;
			const nx = (e.clientX - r.left) / r.width - 0.5;
			const ny = (e.clientY - r.top) / r.height - 0.5;
			camWant = { x: Math.max(-1.2, Math.min(1.2, nx * 2.4)), y: Math.max(-0.9, Math.min(0.9, ny * 1.8)) };
			if (!camRaf) camRaf = requestAnimationFrame(flushCam);
		},
		{ passive: true }
	);
	stage.addEventListener("pointerleave", () => {
		camWant = { x: 0, y: 0 };
		if (!camRaf) camRaf = requestAnimationFrame(flushCam);
	});
}

/* ─────────────────────────── U3：折屏 ↔ 宫格的展平编排 ──────────────
   FLIP：先量折叠态的屏幕矩形，切布局，再量宫格态的矩形，
   把面板用内联 transform 放回折叠态，下一帧清掉 → 它就自己"展平"过去。
   反向（宫格 → 折屏）同理，看起来像把摊开的纸重新折起来。 */

function capturePaneRects() {
	const out = {};
	for (const [id, v] of Object.entries(state.views)) out[id] = v.pane.getBoundingClientRect();
	return out;
}

function playFlip(first, last) {
	const ids = Object.keys(state.views);
	const targets = {};
	let any = false;
	// 展平过程中面板位置在整个变，标签留到落位后再淡入
	for (const v of Object.values(state.views)) if (v.label) v.label.dataset.on = "0";

	ids.forEach((id, i) => {
		const v = state.views[id];
		const f = first[id];
		const l = last[id];
		if (!f || !l || !l.width || !l.height || !f.width || !f.height) return;
		const pane = v.pane;
		// applyLayout 已经写好的目标值，动画结束后要还原成它
		targets[id] = { transform: pane.style.transform, opacity: pane.style.opacity, zIndex: pane.style.zIndex };
		const sx = f.width / l.width;
		const sy = f.height / l.height;
		const dx = f.left + f.width / 2 - (l.left + l.width / 2);
		const dy = f.top + f.height / 2 - (l.top + l.height / 2);
		pane.style.transition = "none";
		pane.style.transformOrigin = "50% 50%";
		pane.style.willChange = "transform, opacity";
		pane.style.zIndex = String(Z_FOCUS + 20 - i);
		pane.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
		pane.style.opacity = "0.2";
		any = true;
	});
	if (!any) {
		positionLabels({ show: true });
		return;
	}

	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			for (const [id, t] of Object.entries(targets)) {
				const pane = state.views[id].pane;
				pane.style.transition = `transform ${DUR_MS}ms var(--ease), opacity ${DUR_MS}ms var(--ease)`;
				pane.style.transform = t.transform;
				pane.style.opacity = t.opacity;
				pane.style.zIndex = t.zIndex;
			}
			markTransitioning();
		});
	});

	clearTimeout(flipTimer);
	flipTimer = setTimeout(() => {
		for (const v of Object.values(state.views)) {
			v.pane.style.transition = "";
			v.pane.style.transformOrigin = "";
		}
		applyLayout({ animate: false });
	}, DUR_MS + 80);
}

function setMode(mode) {
	if (mode === state.mode) return;
	if (stage.dataset.overlay === "1") closeOverlay(); // 弹层与宫格不共存
	const first = capturePaneRects();
	state.mode = mode;
	stage.dataset.mode = mode;
	syncModeButtons();
	applyLayout({ animate: false }); // 先落到目标布局
	const last = capturePaneRects();
	playFlip(first, last);
}

function applyLayout({ animate = true } = {}) {
	const ids = Object.keys(state.views);
	if (!ids.length) return;
	if (animate && state.mode === "focus") markTransitioning();

	const focusIdx = Math.max(0, ids.indexOf(state.focus));
	const P = PRESETS[state.preset] || PRESETS.nav;
	const grid = state.mode === "grid";

	for (const [i, id] of ids.entries()) {
		const v = state.views[id];
		const on = id === state.focus;

		// 环绕距离：让邻位分布在焦点**两侧**，而不是全部堆在右边。
		// 直接用 i - focusIdx 的话，焦点在索引 0 时所有邻位 d 都是正的，
		// 构图会严重偏左。取模到 [-n/2, n/2] 就对称了。
		let d = i - focusIdx;
		const n = ids.length;
		if (d > n / 2) d -= n;
		else if (d < -n / 2) d += n;
		const ad = Math.abs(d);

		v.pane.dataset.focus = on ? "1" : "0";
		if (v.tab) v.tab.dataset.active = on ? "1" : "0";

		if (grid) {
			// 宫格：清掉所有内联布局，交给 CSS Grid
			v.pane.style.transform = "";
			v.pane.style.opacity = "";
			v.pane.style.zIndex = "";
			v.tf = null;
			// 宫格是"总览"模式，四块都要真的渲染出来
			if (v.pane.dataset.tier !== "A") applyTier(v, "A");
			continue;
		}

		if (on) {
			// 焦点态交给 CSS 的 [data-focus="1"] { transform: none }，
			// 这里必须清掉内联值，否则会覆盖成非恒等变换、文字开始重采样
			v.pane.style.transform = "";
			v.pane.style.opacity = "";
			v.pane.style.zIndex = String(Z_FOCUS);
			v.tf = { dx: 0, dy: 0, dz: 0 };
			if (v.pane.dataset.tier !== "A") applyTier(v, "A");
			continue;
		}

		const dz = -ad * P.sz;
		const dx = (d * P.sx) / 100;
		const dy = ad * P.sy;
		v.pane.style.transform =
			`translate3d(${d * P.sx}%, ${ad * P.sy}px, ${dz}px) ` +
			`rotateY(${-d * P.ry}deg) scale(${(1 - ad * P.ss).toFixed(3)})`;
		v.pane.style.opacity = String(Math.max(1 - ad * P.dim, P.minOp));
		v.pane.style.zIndex = zFor(ad);
		// 屏幕空间投影用：dx 是面板宽度的百分比，换算成 px
		v.tf = { dx: dx * (v.pane.offsetWidth || 0), dy, dz };
		applyTier(v, ad === 1 ? "B" : "C");
	}

	positionLabels({ show: !animate });
}

function setPreset(name) {
	if (!PRESETS[name]) return;
	state.preset = name;
	const sel = document.getElementById("preset");
	if (sel && sel.value !== name) sel.value = name;

	// 面板尺寸现在由**每个视图各自持有**（可拖拽调整），预设只负责给
	// 「没被手工调过」的视图套用默认尺寸，不覆盖用户调过的。
	const ps = presetSize(name);
	for (const v of Object.values(state.views)) {
		if (!v.size || !v.custom) v.size = { ...ps };
		applySize(v);
	}
	// ⚠️ 这里**不能**调 persistSizes()：启动时所有视图都还不是 custom，
	// 它会写一个空对象进去，正好在 applyPersistedSizes() 读取之前把存档擦掉。

	// 换预设会改面板尺寸 → 里面整站重排。这是**刻意的、低频的**操作，
	// 与"聚焦切换绝不改尺寸"并不冲突。
	applyLayout({ animate: true });
}

/* ---------------------------------------------------------------- 视图创建 */

function makeTab(p, view) {
	const btn = document.createElement("button");
	btn.className = "tab";
	btn.dataset.id = p.id;
	btn.innerHTML = `<span class="dot" data-s="loading"></span><span>${p.name}</span>`;
	btn.addEventListener("click", () => focusView(p.id));
	tabsEl.appendChild(btn);
	view.tab = btn;
	view.dot = btn.querySelector(".dot");
}

function setViewState(id, s) {
	const v = state.views[id];
	if (!v) return;
	v.state = s;
	if (v.dot) v.dot.dataset.s = s;
	renderStat();
}

/**
 * 解析视图实际要加载的地址。
 *
 * 直连模式（自己控制的站点）有两个坑：
 *   1) 混合内容：hub 是 HTTPS 时不能嵌 http:// 的 iframe，会被直接拦掉；
 *   2) SameSite=Strict 的会话 Cookie 只在**同站**请求里发送，所以如果 hub 与
 *      目标站点不同主机，登录态会丢（酷安会报"缺少或无效的会话 token"）。
 * 两者都靠"按 hub 自己的主机名与协议拼地址"解决，见 platforms.js 的 {host} 占位符。
 */
function resolveUrl(p) {
	const isHttps = location.protocol === "https:";
	const tpl = isHttps ? p.urlTemplateHttps || p.urlTemplate : p.urlTemplate;
	if (tpl) return tpl.replace("{host}", location.hostname);
	if (isHttps && p.urlHttps) return p.urlHttps;
	return p.url;
}

function renderStat() {
	const vals = Object.values(state.views);
	const loaded = vals.filter((v) => v.state === "loaded").length;
	setStat(`${loaded}/${vals.length} 已加载`);
}

function focusView(id) {
	if (!state.views[id]) return;
	state.focus = id;
	if (state.mode !== "focus") {
		state.mode = "focus";
		stage.dataset.mode = "focus";
		syncModeButtons();
	}
	applyLayout({ animate: true });
	const v = state.views[id];
	try {
		v.el.focus();
	} catch {}
}

function syncModeButtons() {
	document.getElementById("mode-focus").dataset.active = state.mode === "focus" ? "1" : "0";
	document.getElementById("mode-grid").dataset.active = state.mode === "grid" ? "1" : "0";
}

/* setMode 定义在上面的 U3 段落里（带 FLIP 展开编排） */

/* ------------------------------------------------- 控制栏：后退/前进/刷新/地址 */

/** ScramjetController 实例，用于把被改写的地址还原成真实网址 */
let controller = null;

/**
 * 取 iframe 当前的真实网址。
 * 代理视图与 hub 同源，可以直接读 location 并用 controller.decodeUrl 还原；
 * 跨源直连视图读不到（返回 null），只能依赖我们自己维护的历史栈。
 */
function realUrlOfEl(el) {
	try {
		const href = el?.contentDocument?.location?.href;
		// ⚠️ 必须过滤掉非 http(s)：
		// iframe 刚被 append、还没开始导航时，contentDocument 是**同源**的
		// about:blank，读得到、也能塞进历史栈 —— 于是地址栏会显示 about:blank，
		// 而且历史栈里凭空多一条。跨源直连视图（酷安）正是这个形态。
		if (!href || !/^https?:/i.test(href)) return null;
		return toRealUrl(href);
	} catch {
		return null;
	}
}

function realUrlOf(view) {
	return realUrlOfEl(view.el);
}

/** 页面内部自己跳转时（点链接），把新地址补进历史栈 */
function syncFromFrame(view) {
	const real = realUrlOf(view);
	if (real && real !== view.hist[view.hidx]) {
		view.hist = view.hist.slice(0, view.hidx + 1);
		view.hist.push(real);
		view.hidx = view.hist.length - 1;
	}
	renderChrome(view);
}

function renderChrome(view) {
	if (!view.addr) return;
	// 正在输入时不要覆盖用户敲的内容
	if (document.activeElement !== view.addr) view.addr.value = view.hist[view.hidx] || "";
	view.btns.back.disabled = view.hidx <= 0;
	view.btns.forward.disabled = view.hidx >= view.hist.length - 1;
}

function goTo(view, url) {
	if (view.frame && typeof view.frame.go === "function") view.frame.go(url);
	else view.el.src = url;
}

function navigate(view, raw) {
	let abs = raw.trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(abs)) abs = "https://" + abs;
	view.hist = view.hist.slice(0, view.hidx + 1);
	view.hist.push(abs);
	view.hidx = view.hist.length - 1;
	view.url = abs;
	goTo(view, abs);
	renderChrome(view);
}

function wireChrome(view) {
	view.btns.back.addEventListener("click", () => {
		if (view.hidx <= 0) return;
		view.hidx--;
		goTo(view, view.hist[view.hidx]);
		renderChrome(view);
	});
	view.btns.forward.addEventListener("click", () => {
		if (view.hidx >= view.hist.length - 1) return;
		view.hidx++;
		goTo(view, view.hist[view.hidx]);
		renderChrome(view);
	});
	view.btns.reload.addEventListener("click", () => {
		try {
			// 代理视图同源，可以直接 reload；跨源会抛，退回重新导航
			view.el.contentWindow?.location?.reload();
			return;
		} catch {}
		goTo(view, view.hist[view.hidx]);
	});

	// ⧉：把当前页在弹层（子视图）里打开 —— 主视图继续用来翻列表，
	// 视频/长文在弹层里看。这也是"在同一页面内弹出子视图"最直接的入口。
	const pop = view.btns.popout;
	if (pop) {
		pop.addEventListener("click", () => {
			const url = view.hist[view.hidx] || realUrlOf(view);
			logOverlay("⧉ 按钮", url || "", url || "", { view: view.id });
			openOverlay(url, view.id);
		});
	}
}

/* --------------------------------------------------------- 拖拽改尺寸 */

const SIZE_MIN = { w: 28, h: 36 };
const SIZE_MAX = { w: 120, h: 110 };
const SIZE_KEY = "zoetrope.sizes";
let resizing = null;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function presetSize(name) {
	const P = PRESETS[name] || PRESETS.nav;
	return { w: parseFloat(P.panelW), h: parseFloat(P.panelH) };
}

function applySize(view) {
	if (!view.size) return;
	view.pane.style.setProperty("--panel-w", view.size.w + "%");
	view.pane.style.setProperty("--panel-h", view.size.h + "%");
}

function persistSizes() {
	try {
		const out = {};
		for (const [id, v] of Object.entries(state.views)) if (v.custom) out[id] = v.size;
		localStorage.setItem(SIZE_KEY, JSON.stringify(out));
	} catch {}
}

function applyPersistedSizes() {
	let saved = {};
	try {
		saved = JSON.parse(localStorage.getItem(SIZE_KEY) || "{}");
	} catch {}
	for (const [id, size] of Object.entries(saved)) {
		const v = state.views[id];
		if (!v || !size || typeof size.w !== "number") continue;
		v.size = { w: size.w, h: size.h };
		v.custom = true;
		applySize(v);
	}
}

function resetSize(id) {
	const v = state.views[id];
	if (!v) return;
	v.size = presetSize(state.preset);
	v.custom = false;
	applySize(v);
	persistSizes();
}

function beginResize(e, id) {
	const v = state.views[id];
	if (!v || state.focus !== id) return;
	e.preventDefault();
	e.stopPropagation();

	const handle = e.currentTarget;
	try { handle.setPointerCapture(e.pointerId); } catch {}

	resizing = {
		id,
		base: { ...(v.size || presetSize(state.preset)) },
		stageRect: stage.getBoundingClientRect(),
		pending: null,
	};

	const onMove = (ev) => resizeMove(ev);
	const onUp = () => {
		handle.removeEventListener("pointermove", onMove);
		handle.removeEventListener("pointerup", onUp);
		handle.removeEventListener("pointercancel", onUp);
		finishResize();
	};
	handle.addEventListener("pointermove", onMove);
	handle.addEventListener("pointerup", onUp);
	handle.addEventListener("pointercancel", onUp);
}

function resizeMove(ev) {
	if (!resizing) return;
	const { base, stageRect } = resizing;
	// 以舞台中心为锚点：拖任一角都对称缩放，面板因此始终居中
	const cx = stageRect.left + stageRect.width / 2;
	const cy = stageRect.top + stageRect.height / 2;
	const w = clamp(((Math.abs(ev.clientX - cx) * 2) / stageRect.width) * 100, SIZE_MIN.w, SIZE_MAX.w);
	const h = clamp(((Math.abs(ev.clientY - cy) * 2) / stageRect.height) * 100, SIZE_MIN.h, SIZE_MAX.h);

	// 拖动期间**只做 transform 缩放**（合成器上跑，零回流）；
	// 真尺寸留到 pointerup 一次性提交 —— 否则拖一次会触发上百次整站重排。
	const v = state.views[resizing.id];
	if (v) v.pane.style.transform = `scale(${w / base.w}, ${h / base.h})`;
	resizing.pending = { w, h };
}

function finishResize() {
	if (!resizing) return;
	const v = state.views[resizing.id];
	if (v) {
		v.pane.style.transform = ""; // 焦点态恢复恒等变换
		if (resizing.pending) {
			v.size = resizing.pending;
			v.custom = true;
			applySize(v);
			persistSizes();
		}
	}
	resizing = null;
}

/* ------------------------------------- 视图内弹层（拦截 _blank / window.open） */

const veilEl = document.getElementById("veil");
const overlayEl = document.getElementById("overlay");
let overlayFrame = null;
/** 弹层导航代次：用来判断"看门狗醒来时用户是不是已经导航到别处了" */
let overlayNavSeq = 0;
let overlayIframe = null;
const ov = { hist: [], hidx: 0 };
const interceptedDocs = new WeakSet();

/**
 * 弹层调用流水（最近的 40 条）。
 * 「弹层打开了但是空白页」这种问题，事后只有最后一帧能看，必须留痕：
 * 谁调的、原始参数是什么、还原之后是什么、调用栈前几层。
 * 用 `__ZOETROPE.overlayLog` 取。
 */
const overlayLog = [];
function logOverlay(kind, raw, final, extra) {
	try {
		overlayLog.push({
			kind,
			raw: typeof raw === "string" ? raw.slice(0, 200) : String(raw).slice(0, 200),
			final: typeof final === "string" ? final.slice(0, 200) : String(final),
			...extra,
			stack: String(new Error().stack || "").split("\n").slice(1, 5).join(" ← ").slice(0, 400),
			t: Date.now(),
		});
		if (overlayLog.length > 40) overlayLog.shift();
	} catch {}
}

/** ScramjetController 的默认前缀；decodeUrl 只会对这个前缀开头的地址有意义 */
const SCRAM_PREFIX = "/scramjet/";

/**
 * 这个地址是不是 Scramjet 改写过的代理地址？
 *
 * ⚠️ 必须先判断再 decode。Scramjet 的 `decodeUrl` 实现是**无条件切片**：
 *     decodeUrl(e) { let t = location.origin + prefix; return P_(e.slice(t.length)) }
 * 喂给它一个没经过代理的普通网址，它会把开头 34 个字符当"前缀"切掉，
 * 再用剩下的碎片做解码 —— 得到一个垃圾结果（实测 `about:blank`）。
 * 而且这个垃圾是 URL 长度相关的：短网址切完是空串，反而"碰巧"走到兜底分支，
 * 于是表现出「有的链接能弹层、有的弹层是空白页」这种鬼一样的随机性。
 */
function isProxiedUrl(u) {
	if (typeof u !== "string") return false;
	return u.startsWith(location.origin + SCRAM_PREFIX) || u.startsWith(SCRAM_PREFIX);
}

/** 把 Scramjet 改写过的代理地址还原成真实网址；不是代理地址就原样返回 */
function toRealUrl(u) {
	if (!u) return u;
	if (controller && isProxiedUrl(u) && typeof controller.decodeUrl === "function") {
		try {
			const d = controller.decodeUrl(u);
			if (d && /^https?:\/\//i.test(d)) return d;
		} catch {}
	}
	return u;
}

/**
 * 把一个**真实网址**变成 hub 页面上能加载的地址。
 *   代理视图  → 必须走 /scramjet/ 编码，否则请求会直连目标站（被 CORS/风控挡掉）
 *   直连视图  → 原样用（跨源图片本来就能显示）
 */
function outboundUrl(url, view) {
	if (!url) return null;
	if (view && view.mode === "proxied" && controller && typeof controller.encodeUrl === "function") {
		try {
			return controller.encodeUrl(url);
		} catch {}
	}
	return url;
}

/**
 * 站点图标彻底取不到时的兜底：平台名首字的圆角徽标。
 * 用 data: URI 内联，不会再发一次请求，也就不可能再失败。
 */
function monogramIcon(name, color) {
	const ch = String(name || "?").trim().slice(0, 1) || "?";
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
		`<rect width="32" height="32" rx="9" fill="${color}"/>` +
		`<text x="16" y="22" text-anchor="middle" font-family="-apple-system,Segoe UI,PingFang SC,sans-serif" font-size="17" font-weight="600" fill="#0b0e13">${ch}</text>` +
		`</svg>`;
	return "data:image/svg+xml," + encodeURIComponent(svg);
}

/**
 * 从**代理视图自己的文档**里读它声明的图标。
 *
 * 这是比 "/favicon.ico" 更靠谱的来源：很多站点的根 favicon 是 301/302
 * （知乎、抖音都是），而文档里的 `<link rel="icon">` 指向真正那份，
 * 可能是 SVG、也可能是 apple-touch-icon。
 *
 * 注意 href 拿到的通常是**真实网址**（Scramjet 不改写属性），所以要自己 encode。
 */
function faviconFromDoc(view) {
	try {
		const d = view.el.contentDocument;
		if (!d) return null;
		// 优先真正的 favicon（通常 16–32px）。apple-touch-icon 常是 152/512px，
		// 塞进 16px 的槽位纯属浪费带宽，所以放到最后兜底。
		const link =
			d.querySelector('link[rel~="icon" i]') ||
			d.querySelector('link[rel="apple-touch-icon" i]');
		if (!link) return null;
		const raw = link.getAttribute("href");
		if (!raw) return null;
		if (/^data:/i.test(raw)) return raw;
		// 相对路径要相对**真实网址**解析，不能相对被改写的 hub 地址
		const base = realUrlOfEl(view.el) || view.hist[view.hidx];
		if (!base) return null;
		const abs = new URL(raw, base).href;
		if (!/^https?:/i.test(abs)) return null;
		return outboundUrl(abs, view);
	} catch {
		return null;
	}
}

/** 给视图设置图标；同一地址不重复赋值，避免打断已解码的图 */
function setFavicon(view, url) {
	const fav = view.fav;
	if (!fav || !url) return;
	if (fav.getAttribute("src") === url) return;
	fav.removeAttribute("data-fb");
	fav.src = url;
}

/**
 * 站点图标的状态机（由 900ms 轮询驱动）。
 *
 * 实际顺序是「**先快后准**」：
 *   1. 面板创建时立刻挂上根 `/favicon.ico`（或平台显式声明的 icon）—— 先有东西显示；
 *   2. 它一旦加载成功就收工（`data-ok`），不再多花一次请求；
 *   3. **只有它失败时**才去找文档声明的 <link rel="icon">，
 *      因为很多站的根 favicon 是 301/302 甚至是空响应（知乎、抖音都是）；
 *   4. 都取不到就退回首字徽标（由 <img> 的 error 处理器兜底，保证这一格永远不空）。
 *
 * ⚠️ 为什么需要"再试一次"这一步：
 * 首屏的图标请求是**在面板创建时立即发出**的，那一刻 `clients.claim()`
 * 可能还没生效 —— 此时 hub 页面尚不受 SW 控制，请求会绕过代理直连静态服务拿到 404。
 * 文档里有 icon 的站点（B 站/知乎）会在下一步升级时自然恢复；
 * 文档里没声明的站点（抖音）则会永久停在徽标上。所以失败过就要等接管后再来一次。
 */
function refreshFavicon(v) {
	const fav = v.fav;
	if (!fav) return;
	if (fav.dataset.ok === "1") return; // 已经拿到真图，不再折腾

	if (v.mode === "proxied" && !fav.dataset.docTried) {
		const ic = faviconFromDoc(v);
		if (ic) {
			fav.dataset.docTried = "1";
			setFavicon(v, ic);
			return;
		}
	}
	if (v.seedIcon && !fav.dataset.seedTried) {
		fav.dataset.seedTried = "1";
		setFavicon(v, v.seedIcon);
		return;
	}
	// 停在徽标上 = 之前那次失败了。等 SW 接管页面后再试一次根 favicon。
	if (v.seedIcon && fav.dataset.fb === "1" && navigator.serviceWorker.controller && !fav.dataset.seedRetried) {
		fav.dataset.seedRetried = "1";
		setFavicon(v, v.seedIcon);
	}
}

function anchorTarget(a, view) {
	const decoded = toRealUrl(a.href || "");
	if (decoded && decoded !== a.href) return decoded;
	const raw = a.getAttribute("href");
	if (!raw) return a.href;
	try {
		return new URL(raw, view.hist[view.hidx] || view.url).href;
	} catch {
		return a.href;
	}
}

/** 弹层自己也要能当"视图"用，才能复用同一套链接拦截 */
const OVERLAY_ID = "__overlay__";
function overlayAsView() {
	return {
		el: overlayIframe,
		id: OVERLAY_ID,
		mode: "proxied",
		// 用 getter：ov.hist 会被整体替换，闭包里抓引用会拿到旧数组
		get hist() { return ov.hist; },
		get hidx() { return ov.hidx; },
		get url() { return ov.hist[ov.hidx]; },
	};
}

/**
 * 从某个视图里开弹层。
 * 如果发起者是弹层自己（点弹层里的 `target=_blank` 链接），要让弹层**原地换页**，
 * 而不是把 from 记成 `__overlay__` —— 那样会让所有主视图的 `under` 标记被清掉，
 * 层次的压暗效果突然消失。
 */
function openFrom(view, url) {
	openOverlay(url, view.id === OVERLAY_ID ? state.overlayFrom : view.id);
}

/**
 * 往**代理视图**里注入拦截器：
 *   - 点 `target=_blank` / `_new` 的链接 → 不再开新标签页，改在视图内弹层打开
 *   - `window.open(url)` → 同上
 * 跨源直连视图（自建酷安）注入不进去，只能放行成新标签页。
 * 文档每次被替换（整页导航）都要重新注入，所以由轮询调用。
 */
function injectInterceptor(view) {
	if (view.mode !== "proxied" || !controller) return;
	let doc, win;
	try {
		doc = view.el.contentDocument;
		win = view.el.contentWindow;
	} catch {
		return;
	}
	if (!doc || !win || interceptedDocs.has(doc)) return;
	interceptedDocs.add(doc);

	// 两条路径都汇到同一个弹层：
	//   1. 链接自己声明 target=_blank/_new（站点想开新标签页）
	//   2. 用户按住 ⌥ / Ctrl / ⌘ 点链接（"在新标签页打开"的肌肉记忆）
	// 点空白处 / 普通左键点链接仍然走视图内导航，不做劫持。
	doc.addEventListener(
		"click",
		(e) => {
			const a = e.target && e.target.closest ? e.target.closest("a") : null;
			if (!a) return;
			const t = (a.getAttribute("target") || "").toLowerCase();
			const newTab = t === "_blank" || t === "_new";
			const mod = e.altKey || e.ctrlKey || e.metaKey;
			if (!newTab && !mod) return;
			e.preventDefault();
			e.stopPropagation();
			const real = anchorTarget(a, view);
			logOverlay(newTab ? "a[target=_blank]" : "修饰键点击", a.href || a.getAttribute("href") || "", real, {
				view: view.id,
				attr: (a.getAttribute("href") || "").slice(0, 120),
			});
			openFrom(view, real);
		},
		true
	);

	// 中键点击同理（auxclick 才拿得到中键）
	doc.addEventListener(
		"auxclick",
		(e) => {
			if (e.button !== 1) return;
			const a = e.target && e.target.closest ? e.target.closest("a") : null;
			if (!a) return;
			e.preventDefault();
			e.stopPropagation();
			const real = anchorTarget(a, view);
			logOverlay("中键点击", a.href || a.getAttribute("href") || "", real, { view: view.id });
			openFrom(view, real);
		},
		true
	);

	try {
		win.open = (url) => {
			if (url) {
				const real = toRealUrl(String(url));
				logOverlay("window.open", String(url), real, { view: view.id });
				openFrom(view, real);
			} else {
				logOverlay("window.open(空参)", "", "", { view: view.id });
			}
			return null;
		};
	} catch {}

	// 焦点在视图内部时，键盘事件不会冒泡到 hub，所以这里也绑一份
	doc.addEventListener(
		"keydown",
		(ev) => {
			if (!(ev.ctrlKey || ev.metaKey) || String(ev.key).toLowerCase() !== "r") return;
			ev.preventDefault();
			ev.stopPropagation();
			if (ev.shiftKey) location.reload();
			else reloadView(view);
		},
		true
	);
}

function ensureOverlay() {
	if (overlayFrame) return;
	overlayFrame = controller.createFrame();
	overlayIframe = overlayFrame.frame || overlayFrame;
	overlayIframe.id = "view-overlay";
	overlayIframe.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
	overlayEl.querySelector(".frame").appendChild(overlayIframe);

	const c = overlayEl.querySelector(".chrome");
	const addr = c.querySelector(".addr");
	const btn = (act) => c.querySelector(`[data-act="${act}"]`);

	btn("close").addEventListener("click", closeOverlay);
	btn("back").addEventListener("click", () => {
		if (ov.hidx <= 0) return;
		ov.hidx--;
		goFrame(ov.hist[ov.hidx]);
		renderOverlayChrome();
	});
	btn("forward").addEventListener("click", () => {
		if (ov.hidx >= ov.hist.length - 1) return;
		ov.hidx++;
		goFrame(ov.hist[ov.hidx]);
		renderOverlayChrome();
	});
	btn("reload").addEventListener("click", () => {
		try {
			overlayIframe.contentWindow?.location?.reload();
			return;
		} catch {}
		goFrame(ov.hist[ov.hidx]);
	});
	addr.addEventListener("keydown", (e) => {
		if (e.key !== "Enter") return;
		e.preventDefault();
		e.stopPropagation();
		let v = e.target.value.trim();
		if (!v) return;
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "https://" + v;
		ov.hist = ov.hist.slice(0, ov.hidx + 1);
		ov.hist.push(v);
		ov.hidx = ov.hist.length - 1;
		goFrame(v);
		renderOverlayChrome();
	});
}

/**
 * 弹层里这个文档是不是"卡死在空白"。
 * 只看一种很确定的形态：还在 loading、没有标题、body 没有内容、一条子资源都没发出去。
 * 正常慢加载的站点（SPA 首屏要几秒）不会同时满足这四条，所以不会误伤。
 */
function overlayLooksStuck(d) {
	if (!d) return true;
	if (d.readyState !== "loading") return false;
	if (d.title) return false;
	if (d.body && d.body.childElementCount > 0) return false;
	try {
		if (d.defaultView.performance.getEntriesByType("resource").length > 0) return false;
	} catch {}
	return true;
}

/** 真正下发导航；不做任何记账 */
function rawGo(url) {
	if (overlayFrame && typeof overlayFrame.go === "function") overlayFrame.go(url);
	else if (overlayIframe) overlayIframe.src = url;
}

/**
 * 弹层导航 + 看门狗重试。
 *
 * 新建的 Scramjet frame **第一次**导航偶发卡死：文档已经提交（location 是目标网址）
 * 但 readyState 永远停在 loading，一个字节都不解析。主视图那边靠 goWithRetry 兜住了，
 * 弹层原先没有兜底，于是表现成"点了链接弹出个空白子视图"。
 */
function goFrame(url) {
	const seq = ++overlayNavSeq;
	rawGo(url);
	watchOverlay(seq, url, 0);
	return seq;
}

async function watchOverlay(seq, url, attempt) {
	await sleep(6000);
	if (seq !== overlayNavSeq) return; // 已经导航到别处了
	if (stage.dataset.overlay !== "1") return; // 弹层被关了
	let d = null;
	try {
		d = overlayIframe && overlayIframe.contentDocument;
	} catch {}
	if (!overlayLooksStuck(d)) return;
	if (attempt >= 2) {
		console.warn("[zoetrope] 弹层连续 3 次停在空白，放弃重试", url);
		return;
	}
	console.warn(`[zoetrope] 弹层停在空白（第 ${attempt + 1} 次），重新发起导航`, url);
	const next = ++overlayNavSeq;
	rawGo(url);
	watchOverlay(next, url, attempt + 1);
}

function renderOverlayChrome() {
	const c = overlayEl.querySelector(".chrome");
	const addr = c.querySelector(".addr");
	if (document.activeElement !== addr) addr.value = ov.hist[ov.hidx] || "";
	c.querySelector('[data-act="back"]').disabled = ov.hidx <= 0;
	c.querySelector('[data-act="forward"]').disabled = ov.hidx >= ov.hist.length - 1;
}

function openOverlay(url, fromId) {
	if (!controller || !url) {
		logOverlay("openOverlay(丢弃)", String(url), "", { reason: !controller ? "controller 未就绪" : "url 为空" });
		return;
	}
	logOverlay("openOverlay", String(url), String(url), { from: fromId });
	ensureOverlay();
	const src = state.views[fromId || state.focus];
	state.overlayFrom = src ? src.id : null;

	// 弹层与主视图同尺寸
	if (src && src.size) {
		overlayEl.style.setProperty("--panel-w", src.size.w + "%");
		overlayEl.style.setProperty("--panel-h", src.size.h + "%");
	}
	ov.hist = [url];
	ov.hidx = 0;
	goFrame(url);
	renderOverlayChrome();

	stage.dataset.overlay = "1";
	for (const v of Object.values(state.views)) {
		v.pane.dataset.under = v.id === state.overlayFrom ? "1" : "0";
	}
}

function closeOverlay() {
	// 弹层里可能正在放视频 —— 关掉就必须掐掉声音，
	// 否则视频会留在隐藏的 iframe 里继续播，用户只听见响、找不到来源。
	try {
		overlayIframe?.contentDocument?.querySelectorAll("video").forEach((v) => {
			try { v.pause(); } catch {}
		});
	} catch {}
	stage.dataset.overlay = "0";
	for (const v of Object.values(state.views)) v.pane.dataset.under = "0";
}

/* ------------------------------------------- cookie 回填 / 地址轮询 */

/**
 * 把 IndexedDB 里持久化的 cookie 罐主动推回给 Service Worker。
 *
 * Scramjet 在 SW 构造函数里用一个**游离的** async IIFE 读 IndexedDB：
 *     (async () => { ...; this.cookieStore.load(t) })(), addEventListener(...)
 * 没有任何人 await 它，所以 SW 刚启动时的前几个请求可能不带 cookie ——
 * 服务器于是当成新会话、重新下发整套 cookie，表现就是**重启后登录态丢失**，
 * 以及登录后重定向死循环（带不上凭据 → 跳回登录页 → 再跳）。
 * 这里在建 frame 之前先推一遍，抢在第一批请求前面。
 */
async function rehydrateCookies() {
	// controller 在首次加载时可能还是 null，用 registration.active 兜底
	let ctl = navigator.serviceWorker.controller;
	if (!ctl) {
		try {
			ctl = (await navigator.serviceWorker.ready).active;
		} catch {}
	}
	if (!ctl) return 0;
	try {
		const db = await new Promise((res, rej) => {
			const r = indexedDB.open("$scramjet");
			r.onsuccess = () => res(r.result);
			r.onerror = () => rej(r.error);
		});
		if (!db.objectStoreNames.contains("cookies")) return 0;
		const rec = await new Promise((res) => {
			const q = db.transaction("cookies", "readonly").objectStore("cookies").get("cookies");
			q.onsuccess = () => res(q.result);
			q.onerror = () => res(null);
		});
		const jar = rec && rec.value ? rec.value : rec;
		if (!jar || typeof jar !== "object") return 0;

		let n = 0;
		for (const key of Object.keys(jar)) {
			const c = jar[key];
			if (!c || typeof c.name !== "string" || typeof c.value !== "string") continue;
			const host = String(c.domain || "").replace(/^\./, "");
			if (!host) continue;

			// ⚠️ SW 侧走的是 cookieStore.setCookies([cookie], url)，它接受的是
			// **Set-Cookie 字符串**，不是对象。推对象进去会被 String() 成
			// "[object Object]"，解析出 undefined=undefined 这种垃圾条目。
			let str = `${c.name}=${c.value}`;
			if (c.domain) str += `; Domain=${c.domain}`;
			str += `; Path=${c.path || "/"}`;
			if (c.maxAge) str += `; Max-Age=${c.maxAge}`;
			if (c.expires) {
				const d = new Date(c.expires);
				if (!Number.isNaN(d.getTime())) str += `; Expires=${d.toUTCString()}`;
			}
			if (c.sameSite) str += `; SameSite=${c.sameSite}`;
			if (c.secure) str += "; Secure";
			if (c.httpOnly) str += "; HttpOnly";

			ctl.postMessage({ scramjet$type: "cookie", cookie: str, url: "https://" + host + "/" });
			n++;
		}
		return n;
	} catch (e) {
		console.warn("[zoetrope] cookie 回填失败", e);
		return 0;
	}
}

/**
 * 定时轮询各视图的真实地址。
 * 单页应用（三个平台都是）内部跳转**不会触发 iframe 的 load 事件**，
 * 所以地址栏会停在旧值 —— 这里轮询补上，并顺手重新注入拦截器。
 */
function startViewPolling() {
	setInterval(() => {
		for (const v of Object.values(state.views)) {
			injectInterceptor(v);
			const real = realUrlOf(v);
			if (real && real !== v.hist[v.hidx]) {
				v.hist = v.hist.slice(0, v.hidx + 1);
				v.hist.push(real);
				v.hidx = v.hist.length - 1;
			}
			renderChrome(v);
			refreshFavicon(v);
			// C 档停渲染，但站点可能**稍后**才开始自动播放 —— 每次轮询兜一次
			if (v.pane.dataset.tier === "C") pauseMediaIn(v.el);
		}
		if (overlayIframe) {
			try {
				injectInterceptor(overlayAsView());
			} catch {}
			try {
				const real = realUrlOfEl(overlayIframe);
				if (real && real !== ov.hist[ov.hidx]) {
					ov.hist = ov.hist.slice(0, ov.hidx + 1);
					ov.hist.push(real);
					ov.hidx = ov.hist.length - 1;
				}
			} catch {}
			renderOverlayChrome();
		}
	}, 900);
}

/* ------------------------------------------------------------------ 启动 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 预热传输层。
 *
 * libcurl-transport 的 WASM 是**懒加载**的：在它加载完成之前发出的第一个请求会被
 * Service Worker 直接拒掉，日志是
 *   ERROR FROM SERVICE WORKER FETCH: Error: wasm not loaded yet, please call libcurl.load_wasm first
 * 表现为**第一个平台间歇性加载失败**（正是 platforms[0]），且失败概率取决于 WASM 加载快慢。
 *
 * 这里先反复打一个极小的请求（默认取第一个平台的 /favicon.ico）直到成功，再创建各平台 frame。
 */
async function warmUpTransport(scramjet, url, tries = 20, budgetMs = 2500) {
	const t0 = performance.now();
	const left = () => budgetMs - (performance.now() - t0);
	for (let i = 0; i < tries; i++) {
		// ⚠️ 页面还没被 SW 接管时，这个请求会**绕过代理**直连静态服务拿到 404。
		// 404 < 500，会被下面的判定当成"预热成功" —— 于是首屏那次预热其实是空转。
		// （`sw.js` 补了 clients.claim() 之后这个窗口很短，但仍然要挡住。）
		if (!navigator.serviceWorker.controller) {
			if (left() <= 0) return 0;
			await sleep(200);
			continue;
		}
		try {
			const r = await fetch(scramjet.encodeUrl(url), {
				cache: "no-store",
				// 单次请求也要有上限，否则一次卡死就把预算全吃掉
				signal: AbortSignal.timeout(2500),
			});
			if (r.status < 500) {
				await r.arrayBuffer().catch(() => {});
				return i + 1;
			}
		} catch {
			/* 传输层还没热，继续重试 */
		}
		if (left() <= 0) return 0;
		await sleep(300);
	}
	return 0;
}

/**
 * 导航并校验，失败则重试。
 * 预热之后本不该再触发，作为兜底：只把"仍停在 Scramjet 自己的占位/错误页"
 * （标题恰好是 "Scramjet"）判定为失败，避免把加载慢的正常页面误判成失败。
 */
async function goWithRetry(el, frame, url, id, attempts = 3) {
	for (let i = 0; i < attempts; i++) {
		try {
			if (frame && typeof frame.go === "function") frame.go(url);
			else el.src = url;
		} catch (e) {
			console.warn("[zoetrope] go 异常", id, e);
		}
		for (let w = 0; w < 16; w++) {
			await sleep(500);
			const d = el.contentDocument;
			if (!d) return true; // 跨源：交给 load 事件判断
			if (d.title && d.title !== "Scramjet") return true;
			const t = state.views[id];
			if (t && t.state === "error") break;
		}
		console.warn(`[zoetrope] ${id} 第 ${i + 1} 次导航未生效，重试`);
	}
	return false;
}

/* ─────────────────── 启动编排：焦点优先，分批放行 ───────────────────
 *
 * 四个平台同时开，看起来"并行更快"，实测恰恰相反：
 *   · 四路流量挤在**同一条** Wisp WebSocket 上，互相排队
 *   · 四个同源 iframe 在**同一个渲染进程**里（原生浏览器是每站一个进程），
 *     首屏 JS 的执行互相抢主线程
 * 结果就是用户看到的"点开之后很久什么都没有"。
 *
 * 改成按「到焦点的环绕距离」分三批放行：焦点 → 邻位 → 远端。
 * 焦点视图先拿到整条链路，首屏明显更快；其余的随后补齐。
 */

function bootRank(platforms, firstId) {
	const ids = platforms.map((p) => p.id);
	const n = ids.length;
	const i0 = Math.max(0, ids.indexOf(firstId));
	return (id) => {
		let d = ids.indexOf(id) - i0;
		if (d > n / 2) d -= n;
		else if (d < -n / 2) d += n;
		return Math.abs(d);
	};
}

function bootNavigateOrdered(platforms, firstId) {
	const rank = bootRank(platforms, firstId);
	const ordered = [...platforms].sort((a, b) => rank(a.id) - rank(b.id));

	const start = (p) => {
		const v = state.views[p.id];
		if (!v || v.started || !v.bootUrl) return;
		v.started = true;
		T[`start:${p.id}`] = performance.now();
		// 不 await：失败重试在后台进行
		goWithRetry(v.el, v.frame, v.bootUrl, p.id);
	};

	const first = ordered[0];
	if (!first) return;
	start(first);

	const neighbours = () => {
		for (const p of ordered) if (rank(p.id) === 1) start(p);
	};
	const rest = () => {
		for (const p of ordered) start(p);
	};

	const v0 = state.views[first.id];
	// 邻位：焦点视图 load 一出就走（2.5s 兜底，别让慢站把别人饿死）
	let nTimer = setTimeout(() => {
		T.bootNeighbours = performance.now();
		neighbours();
	}, 2500);
	v0.el.addEventListener(
		"load",
		() => {
			clearTimeout(nTimer);
			T.bootNeighbours = performance.now();
			neighbours();
		},
		{ once: true }
	);

	// 远端：焦点视图 load 之后再留 1.5s 让它自己的后续资源先跑完（8s 兜底）
	let rTimer = setTimeout(() => {
		T.bootRest = performance.now();
		rest();
	}, 8000);
	v0.el.addEventListener(
		"load",
		() => {
			setTimeout(() => {
				clearTimeout(rTimer);
				T.bootRest = performance.now();
				rest();
			}, 1500);
		},
		{ once: true }
	);
}

/** 滚轮切换的 debounce */
let wheelLock = 0;

function reloadView(view) {
	try {
		view.el.contentWindow?.location?.reload();
		return;
	} catch {}
	goTo(view, view.hist[view.hidx]);
}

function reloadFocused() {
	const v = state.views[state.focus];
	if (v) reloadView(v);
}

/* ------------------------------------------------------- 设置：站点列表 */

const SITES_KEY = "zoetrope.sites";

const esc = (t) =>
	String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function addSiteRow(container, site, srcIndex) {
	const row = document.createElement("div");
	row.className = "site-row";
	if (srcIndex !== undefined) row.dataset.src = String(srcIndex);
	const url = site ? site.url || site.urlTemplate || "" : "";
	row.innerHTML =
		`<span class="dot"></span>` +
		`<input type="text" data-k="name" value="${esc(site ? site.name || "" : "")}" placeholder="名称" />` +
		`<input type="text" data-k="url" value="${esc(url)}" placeholder="地址，支持 {host}" />` +
		`<label><input type="checkbox" data-k="proxied" ${!site || site.proxied !== false ? "checked" : ""} />代理</label>` +
		`<button class="ctl" title="删除">✕</button>`;
	row.querySelector(".dot").style.background = (site && site.accent) || "#58a6ff";
	row.querySelector("button").addEventListener("click", () => row.remove());
	container.appendChild(row);
	return row;
}

function renderSites() {
	const box = document.getElementById("sites");
	box.innerHTML = "";
	(window.PLATFORMS || []).forEach((p, i) => addSiteRow(box, p, i));
}

function openSettings() {
	renderSites();
	document.getElementById("settings-modal").hidden = false;
}

function closeSettings() {
	document.getElementById("settings-modal").hidden = true;
}

function saveSites() {
	const base = window.PLATFORMS || [];
	const out = [];
	let n = 0;
	for (const row of document.querySelectorAll("#sites .site-row")) {
		const name = row.querySelector('[data-k="name"]').value.trim();
		const url = row.querySelector('[data-k="url"]').value.trim();
		const proxied = row.querySelector('[data-k="proxied"]').checked;
		if (!url) continue;
		const src = row.dataset.src;
		// 从原对象拷贝，保留 accent / urlTemplateHttps 这些表单里没有的字段
		const entry = src !== undefined && base[Number(src)] ? { ...base[Number(src)] } : { accent: "#58a6ff" };
		delete entry.url;
		delete entry.urlTemplate;
		entry.id = entry.id || "site" + n;
		entry.name = name || url;
		entry.proxied = proxied;
		if (url.includes("{host}")) {
			entry.urlTemplate = url;
			// :17520 的明文入口，其 HTTPS 对应端口是 :17521（见 tls/Caddyfile）
			if (/:17520\/?/.test(url)) {
				entry.urlTemplateHttps = url.replace("http://", "https://").replace(":17520", ":17521");
			} else {
				delete entry.urlTemplateHttps;
			}
		} else {
			entry.url = url;
			delete entry.urlTemplateHttps;
		}
		out.push(entry);
		n++;
	}
	try {
		localStorage.setItem(SITES_KEY, JSON.stringify(out));
	} catch (e) {
		console.warn("[zoetrope] 站点列表保存失败", e);
	}
	location.reload();
}

function bindSettings() {
	const modal = document.getElementById("settings-modal");
	document.getElementById("settings").addEventListener("click", openSettings);
	document.getElementById("settings-close").addEventListener("click", closeSettings);
	document.getElementById("site-add").addEventListener("click", () =>
		addSiteRow(document.getElementById("sites"), null)
	);
	document.getElementById("site-reset").addEventListener("click", () => {
		try {
			localStorage.removeItem(SITES_KEY);
		} catch {}
		location.reload();
	});
	document.getElementById("site-save").addEventListener("click", saveSites);
	modal.addEventListener("click", (e) => {
		if (e.target === modal) closeSettings();
	});
}

function bindInteractions() {
	document.getElementById("mode-focus").addEventListener("click", () => setMode("focus"));
	document.getElementById("mode-grid").addEventListener("click", () => setMode("grid"));
	document.getElementById("preset").addEventListener("change", (e) => setPreset(e.target.value));

	// 滚轮 / 触控板横向滑动切焦点
	stage.addEventListener(
		"wheel",
		(e) => {
			if (state.mode !== "focus") return;
			const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
			if (Math.abs(dx) < 24) return;
			const now = Date.now();
			if (now < wheelLock) return;
			wheelLock = now + 260;
			window.__ZOETROPE.next(dx > 0 ? 1 : -1);
		},
		{ passive: true }
	);

	window.addEventListener("keydown", (e) => {
		// Ctrl+R：刷新当前焦点视图；Ctrl+Shift+R：刷新整个页面
		if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "r") {
			e.preventDefault();
			if (e.shiftKey) return location.reload();
			return reloadFocused();
		}
		if ((e.ctrlKey || e.metaKey) && e.key === ",") {
			e.preventDefault();
			return openSettings();
		}
		if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
		if (e.key === "[" || e.key === "ArrowLeft") return window.__ZOETROPE.next(-1);
		if (e.key === "]" || e.key === "ArrowRight") return window.__ZOETROPE.next(1);
		if (e.key === "g" || e.key === "G") return setMode(state.mode === "grid" ? "focus" : "grid");
		if (e.key === "Escape") {
			if (!document.getElementById("settings-modal").hidden) return closeSettings();
			if (stage.dataset.overlay === "1") return closeOverlay();
			return setMode("focus");
		}
		if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
			const ids = Object.keys(state.views);
			const id = ids[Number(e.key) - 1];
			if (id) focusView(id);
		}
	});
}

async function main() {
	tMark("main");
	const platforms = window.PLATFORMS || [];
	if (!platforms.length) throw new Error("platforms.js 未定义任何平台");

	const { ScramjetController } = $scramjetLoadController();
	const scramjet = new ScramjetController({
		files: {
			wasm: "/scram/scramjet.wasm.wasm",
			all: "/scram/scramjet.all.js",
			sync: "/scram/scramjet.sync.js",
		},
	});
	scramjet.init();
	controller = scramjet; // 供控制栏把改写过的地址还原成真实网址

	// 1) 先注册 Service Worker，后续所有经代理的请求都由它响应
	setStat("注册 Service Worker…");
	await registerSW();
	tMark("sw");

	// 2) 配置传输层：经 Wisp 建立到目标站点的 TCP
	setStat("连接 Wisp…");
	const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
	if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
		await connection.setTransport("/libcurl/index.mjs", [{ websocket: wispUrl }]);
	}
	tMark("transport");

	// 3) 抢在第一批代理请求之前，把持久化的 cookie 罐推回给 Service Worker
	//    （否则 SW 冷启动时的请求不带 cookie → 登录态丢失 / 重定向死循环）
	const restored = await rehydrateCookies();
	console.log(`[zoetrope] cookie 回填 ${restored} 条`);
	tMark("cookies");

	// 4) 预热传输层：不这么做的话，第一个平台会撞上 "wasm not loaded yet"
	const firstProxied = platforms.find((p) => p.proxied !== false);
	if (firstProxied) {
		setStat("预热传输层…");
		let warmUrl = firstProxied.url;
		try {
			warmUrl = new URL("/favicon.ico", firstProxied.url).href;
		} catch {}
		const tried = await warmUpTransport(scramjet, warmUrl);
		tMark("warm");
		console.log(
			tried
				? `[zoetrope] 传输层预热成功（第 ${tried} 次尝试）`
				: "[zoetrope] 传输层预热失败，仍继续加载"
		);
	}

	// 5) 每个平台一个面板
	for (const p of platforms) {
		const pane = document.createElement("div");
		pane.className = "pane";
		pane.dataset.id = p.id;
		pane.dataset.focus = "0";
		pane.style.setProperty("--accent", p.accent || "#58a6ff");
		stage.appendChild(pane);

		const targetUrl = resolveUrl(p);
		const view = {
			id: p.id,
			name: p.name,
			url: targetUrl,
			pane,
			el: null,
			state: "loading",
			mode: p.proxied === false ? "direct" : "proxied",
			hist: [targetUrl], // 自维护的历史栈（跨源直连读不到 location，只能靠自己记）
			hidx: 0,
			size: null, // { w, h }，单位是舞台的百分比
			custom: false, // 用户是否手工拖过尺寸
		};
		state.views[p.id] = view;
		makeTab(p, view);

		// U6 接触阴影：DOM 上排在 .clip 之前，靠文档序压在面板下方
		const shadow = document.createElement("div");
		shadow.className = "shadow";
		pane.appendChild(shadow);

		// 控制栏：高度恒定，所有面板都保留这块空间（否则焦点切换会改 iframe 高度 → 整站重排）
		// 视图本体（裁剪 + 圆角 + 包边）；手柄挂在 pane 上，才能露到外面
		const clip = document.createElement("div");
		clip.className = "clip";
		pane.appendChild(clip);

		const chrome = document.createElement("div");
		chrome.className = "chrome";
		chrome.innerHTML =
			`<button class="ctl" data-act="back" title="后退">‹</button>` +
			`<button class="ctl" data-act="forward" title="前进">›</button>` +
			`<button class="ctl" data-act="reload" title="刷新">⟳</button>` +
			`<button class="ctl" data-act="popout" title="在弹层中打开当前页（⌥/Ctrl+点击站内链接同理）">⧉</button>` +
			`<input class="addr" spellcheck="false" placeholder="输入网址后回车" />` +
			`<span class="name">${p.name}</span>`;
		clip.appendChild(chrome);

		// ── 控制栏最左侧的站点图标 ──────────────────────────────
		// 初值用平台自己声明的 icon，或从目标站根推 /favicon.ico；
		// 等文档就绪后再升级成它 <link rel="icon"> 里真正声明的那份。
		// 两者都失败（或跨源取不到）就退回首字徽标，保证这一格永远不空。
		const fav = document.createElement("img");
		fav.className = "fav";
		fav.alt = "";
		fav.decoding = "async";
		fav.referrerPolicy = "no-referrer";
		fav.addEventListener("load", () => {
			fav.dataset.ok = "1";
		});
		fav.addEventListener("error", () => {
			fav.removeAttribute("data-ok");
			if (fav.src.startsWith("data:")) return; // 已经在用徽标了，别再递归
			fav.dataset.fb = "1";
			fav.src = monogramIcon(p.name, p.accent || "#58a6ff");
		});
		chrome.prepend(fav);
		view.fav = fav;

		let seedIcon = p.icon || null;
		if (!seedIcon) {
			try {
				seedIcon = new URL("/favicon.ico", targetUrl).href;
			} catch {}
		}
		view.seedIcon = outboundUrl(seedIcon, view);
		if (view.seedIcon) {
			fav.dataset.seedTried = "1";
			setFavicon(view, view.seedIcon);
		} else {
			fav.dataset.fb = "1";
			fav.src = monogramIcon(p.name, p.accent || "#58a6ff");
		}

		const frameBox = document.createElement("div");
		frameBox.className = "frame";
		clip.appendChild(frameBox);

		let frame = null;
		let el;
		if (p.proxied === false) {
			// 自己控制的站点：直接 iframe，不经代理（跨源，故读不到 contentDocument）
			el = document.createElement("iframe");
		} else {
			frame = scramjet.createFrame();
			el = frame.frame || frame;
		}
		el.id = "view-" + p.id;
		el.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
		frameBox.appendChild(el);

		// 遮罩：压暗 + 在非焦点态接管点击（面板本身在非焦点态不吃指针）
		const scrim = document.createElement("div");
		scrim.className = "scrim";
		scrim.addEventListener("click", () => focusView(p.id));
		clip.appendChild(scrim);

		// 右下角一个把手就够：面板以舞台中心为锚点缩放，四角等价
		const handle = document.createElement("div");
		handle.className = "handle";
		handle.title = "拖动改尺寸（双击复位）";
		handle.addEventListener("pointerdown", (e) => beginResize(e, p.id));
		handle.addEventListener("dblclick", () => resetSize(p.id));
		pane.appendChild(handle);

		view.el = el;
		view.frame = frame;
		view.scrim = scrim;
		view.chrome = chrome;
		view.clip = clip;
		view.frameBox = frameBox;
		view.shadow = shadow;
		// U6 屏幕空间标签（挂在 #labels 上，不参与 3D 变换）
		const label = document.createElement("div");
		label.className = "slabel";
		label.textContent = p.name;
		labelsEl.appendChild(label);
		view.label = label;
		view.addr = chrome.querySelector(".addr");
		view.btns = {
			back: chrome.querySelector('[data-act="back"]'),
			forward: chrome.querySelector('[data-act="forward"]'),
			reload: chrome.querySelector('[data-act="reload"]'),
			popout: chrome.querySelector('[data-act="popout"]'),
		};
		wireChrome(view);

		view.addr.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			e.stopPropagation();
			const v = e.target.value.trim();
			if (v) navigate(view, v);
		});

		el.addEventListener("load", () => {
			if (!T["load:" + p.id]) T["load:" + p.id] = performance.now();
			setViewState(p.id, "loaded");
			syncFromFrame(view);
		});
		el.addEventListener("error", () => setViewState(p.id, "error"));

		// 导航**不在这里**发起：四路同时开会让同一个 Wisp 隧道 + 同一个渲染进程
		// 互相抢带宽和主线程，结果是"点开半天什么都没有"。见 bootNavigateOrdered。
		view.bootUrl = targetUrl;
	}

	// 6) 初始布局：先套预设尺寸，再用用户存下来的尺寸覆盖；然后开轮询
	setPreset(state.preset);
	applyPersistedSizes();
	focusView(platforms[0].id);
	bindInteractions();
	bindSettings();
	bindCamera();
	startViewPolling();
	// 6.5) 分批放行导航：焦点视图先走，邻位随后，远端最后
	bootNavigateOrdered(platforms, state.focus);
	// 弹层关闭按钮之外，点遮罩也关
	veilEl.addEventListener("click", closeOverlay);

	tMark("frames");
	tMark("ready");
	state.ready = true;
	bootEl.hidden = true;
	renderStat();
}

main().catch((e) => {
	bootFail(e);
	state.ready = false;
});
