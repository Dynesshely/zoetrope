#!/usr/bin/env node
/**
 * 弹层到底是不是"半透明"？—— 像素级判定，不靠肉眼。
 *
 * 判据：把弹层背后所有 .pane 与 #veil 全部藏起来，再截同一块区域。
 *   · 如果像素完全一致  → 弹层是不透明的，用户看到的"半透明"另有原因
 *   · 如果像素发生变化  → 底层真的透上来了，就是合成/z-index/opacity 问题
 *
 * 同时 dump 弹层及祖先链上的 opacity / filter / mix-blend-mode / backdrop-filter，
 * 以及弹层与"被压层级"面板的矩形差（面板放大后会从弹层四周露出来，这也会读成"半透明"）。
 *
 * 用法：HUB_URL=http://localhost:18095/ OUT_DIR=verify/ovl-alpha node verify/overlay-alpha-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19810);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "ovl-alpha");
const VIDEO = process.env.VIDEO || "https://www.bilibili.com/video/BV1ZDan66EdQ/";

async function findBrowser() {
	if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
	const root = path.join(os.homedir(), ".cache", "ms-playwright");
	for (const dir of (await readdir(root)).sort().reverse()) {
		if (!dir.startsWith("chromium_headless_shell")) continue;
		const p = path.join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
		if (existsSync(p)) return p;
	}
	throw new Error("找不到 chrome-headless-shell");
}
class CDP {
	constructor(ws) {
		this.ws = ws; this.seq = 0; this.pending = new Map();
		ws.addEventListener("message", (ev) => {
			const m = JSON.parse(ev.data);
			if (m.id && this.pending.has(m.id)) {
				const { resolve, reject } = this.pending.get(m.id);
				this.pending.delete(m.id);
				m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
			}
		});
	}
	send(method, params = {}) {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => { if (this.pending.delete(id)) reject(new Error(method + " 超时")); }, 30000);
		});
	}
	async evaluate(expression) {
		const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) return "__EXCEPTION__ " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
		return r.result.value;
	}
	async rawShot(f) {
		const r = await this.send("Page.captureScreenshot", { format: "png" });
		await writeFile(f, Buffer.from(r.data, "base64"));
		return r.data;
	}
	async clipShot(f, clip) {
		const r = await this.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
		await writeFile(f, Buffer.from(r.data, "base64"));
		return r.data;
	}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b64) => crypto.createHash("sha256").update(b64).digest("hex").slice(0, 16);

await mkdir(OUT, { recursive: true });
const out = { steps: [] };
let child;
try {
	const BIN = await findBrowser();
	child = spawn(BIN, [
		"--no-sandbox", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "zoetrope-alpha-" + Date.now())}`,
		"--window-size=1680,1000",
		...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
		HUB,
	], { stdio: ["ignore", "ignore", "ignore"] });

	let target = null;
	for (let i = 0; i < 60 && !target; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
		} catch {}
		if (!target) await sleep(500);
	}
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true });
		ws.addEventListener("error", () => rej(new Error("ws 失败")), { once: true });
	});
	const cdp = new CDP(ws);
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");

	for (let i = 0; i < 90; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(1000);
	}
	await sleep(15000);
	await cdp.evaluate(`window.__ZOETROPE.openOverlay(${JSON.stringify(VIDEO)}, "bilibili")`);
	await sleep(30000);

	/* ── 几何 + 样式链 ──────────────────────────────────────── */
	out.diag = await cdp.evaluate(`(() => {
		const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
		const ovl = document.getElementById("overlay");
		const chain = [];
		for (let el = ovl; el && el !== document.documentElement; el = el.parentElement) {
			const s = getComputedStyle(el);
			chain.push({
				sel: el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""),
				opacity: s.opacity, filter: s.filter, mixBlendMode: s.mixBlendMode,
				backdropFilter: s.backdropFilter, transformStyle: s.transformStyle,
				perspective: s.perspective, isolation: s.isolation, zIndex: s.zIndex, position: s.position,
				contain: s.contain, willChange: s.willChange, background: s.backgroundColor,
			});
		}
		const under = document.querySelector('.pane[data-under="1"]');
		const ifr = document.getElementById("view-overlay");
		return {
			overlayRect: r(ovl),
			overlayChain: chain,
			stageRect: r(document.getElementById("stage")),
			underRect: under ? r(under) : null,
			focusedPaneRect: (() => { const p = document.querySelector('.pane[data-focus="1"]'); return p ? r(p) : null; })(),
			iframeRect: ifr ? r(ifr) : null,
			overlayCss: (() => { const s = getComputedStyle(ovl); return { opacity: s.opacity, bg: s.backgroundColor, isolation: s.isolation, transform: s.transform }; })(),
			iframeCss: (() => { const s = getComputedStyle(ifr); return { bg: s.backgroundColor, opacity: s.opacity }; })(),
			docBg: (() => { try { const d = ifr.contentDocument; return { html: getComputedStyle(d.documentElement).backgroundColor, body: d.body ? getComputedStyle(d.body).backgroundColor : null }; } catch (e) { return String(e); } })(),
			paneCss: under ? (() => { const s = getComputedStyle(under); return { opacity: s.opacity, transform: s.transform, zIndex: s.zIndex }; })() : null,
		};
	})()`);
	out.steps.push("弹层矩形：" + JSON.stringify(out.diag.overlayRect));
	out.steps.push("祖先链：" + JSON.stringify(out.diag.overlayChain));
	out.steps.push("被压层级面板矩形：" + JSON.stringify(out.diag.underRect) + "  弹层自身：" + JSON.stringify(out.diag.overlayRect));
	out.steps.push("弹层 CSS：" + JSON.stringify(out.diag.overlayCss) + " iframe：" + JSON.stringify(out.diag.iframeCss) + " 页面底色：" + JSON.stringify(out.diag.docBg));

	/* ── 像素比对 ───────────────────────────────────────────── */
	const clip = { x: out.diag.overlayRect[0], y: out.diag.overlayRect[1], width: out.diag.overlayRect[2], height: out.diag.overlayRect[3] };
	const a = await cdp.clipShot(path.join(OUT, "a-with-panes.png"), clip);
	await cdp.rawShot(path.join(OUT, "a-full.png"));

	// 把弹层背后的一切都藏掉，只留 #stage 的底色
	await cdp.evaluate(`(() => {
		const s = document.createElement("style");
		s.id = "__hide_under";
		s.textContent = "#veil{display:none !important} .pane{visibility:hidden !important}";
		document.head.appendChild(s);
	})()`);
	await sleep(1200);
	const b = await cdp.clipShot(path.join(OUT, "b-no-panes.png"), clip);
	await cdp.rawShot(path.join(OUT, "b-full.png"));

	out.pixelCompare = { shaWithPanes: sha(a), shaWithoutPanes: sha(b), identical: sha(a) === sha(b), lenA: a.length, lenB: b.length };
	out.steps.push(`像素比对：藏掉底层后 ${out.pixelCompare.identical ? "完全一致 → 弹层不透明 ✅" : "有变化 → 底层确实透上来了 ❌"}  (${out.pixelCompare.shaWithPanes} vs ${out.pixelCompare.shaWithoutPanes})`);

	// 解码具体像素点，量化差异
	const sample = async (b64, pts) => cdp.evaluate(`(async () => {
		const img = new Image();
		img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
		await img.decode();
		const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
		const g = c.getContext("2d"); g.drawImage(img, 0, 0);
		const pts = ${JSON.stringify(pts)};
		return pts.map(([x, y]) => { const d = g.getImageData(Math.max(0,Math.min(img.width-1,x)), Math.max(0,Math.min(img.height-1,y)), 1, 1).data; return [d[0], d[1], d[2], d[3]]; });
	})()`);
	const pts = [[Math.round(clip.width / 2), Math.round(clip.height / 2)], [10, Math.round(clip.height / 2)], [4, 4], [Math.round(clip.width) - 10, Math.round(clip.height) - 10]];
	out.pixels = { withPanes: await sample(a, pts), withoutPanes: await sample(b, pts), points: pts };
	out.steps.push("像素点（有/无底层）：" + JSON.stringify(out.pixels));

	// 逐像素 diff：差异有多少、集中在哪、最大通道差多少
	out.diff = await cdp.evaluate(`(async () => {
		const load = async (b64) => { const i = new Image(); i.src = "data:image/png;base64," + b64; await i.decode(); return i; };
		const [ia, ib] = [await load(${JSON.stringify(a)}), await load(${JSON.stringify(b)})];
		const c = document.createElement("canvas"); c.width = ia.width; c.height = ia.height;
		const g = c.getContext("2d", { willReadFrequently: true });
		g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
		g.clearRect(0, 0, c.width, c.height);
		g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
		let n = 0, maxd = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
		const hot = [];
		for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
			const i = (y * c.width + x) * 4;
			const d = Math.max(Math.abs(da[i]-db[i]), Math.abs(da[i+1]-db[i+1]), Math.abs(da[i+2]-db[i+2]));
			if (d > 2) {
				n++; if (d > maxd) maxd = d;
				if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
				if (hot.length < 6) hot.push([x, y, d, [da[i],da[i+1],da[i+2]], [db[i],db[i+1],db[i+2]]]);
			}
		}
		return { w: c.width, h: c.height, diffPixels: n, totalPixels: c.width*c.height, maxDelta: maxd,
			bbox: maxX < 0 ? null : [minX, minY, maxX, maxY], hot };
	})()`);
	out.steps.push("逐像素 diff：" + JSON.stringify(out.diff));

	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}
await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
for (const s of out.steps) console.log("•", s);
console.log("fatal:", out.fatal || "-");
process.exit(0);
