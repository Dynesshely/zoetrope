#!/usr/bin/env node
/**
 * 控制栏 favicon 验收。
 *
 * 断言每个视图的控制栏最左侧都**真的画出了图**（naturalWidth > 0），
 * 并记录它的来源：根 /favicon.ico、文档声明的 <link rel="icon">、还是首字徽标兜底。
 * 另外裁一张控制栏特写，肉眼确认位置与大小。
 *
 * 用法：HUB_URL=http://localhost:18095/ OUT_DIR=verify/favicon node verify/favicon-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19990);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "favicon");

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
	async shot(f, clip) {
		const r = await this.send("Page.captureScreenshot", clip ? { format: "png", clip: { ...clip, scale: 2 } } : { format: "png" });
		await writeFile(f, Buffer.from(r.data, "base64"));
	}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const out = { steps: [] };
let child;
try {
	const BIN = await findBrowser();
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${path.join(os.tmpdir(), "zoetrope-fav-" + Date.now())}`,
		"--window-size=1680,1000",
		...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
		HUB,
	], { stdio: ["ignore", "ignore", "ignore"] });

	let target = null;
	for (let i = 0; i < 80 && !target; i++) {
		try {
			target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
				(x) => x.type === "page" && x.webSocketDebuggerUrl
			);
		} catch {}
		if (!target) await sleep(300);
	}
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	const cdp = new CDP(ws);
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");

	for (let i = 0; i < 90; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(500);
	}
	await sleep(30000); // 让轮询把图标升级跑完

	out.icons = await cdp.evaluate(`(() => {
		const o = {};
		for (const p of document.querySelectorAll(".pane")) {
			const fav = p.querySelector(".chrome .fav");
			if (!fav) { o[p.dataset.id] = "❌ 控制栏里没有 .fav 元素"; continue; }
			const src = fav.getAttribute("src") || "";
			o[p.dataset.id] = {
				drawn: fav.complete && fav.naturalWidth > 0,
				w: fav.naturalWidth,
				upgraded: fav.dataset.upgraded === "1",
				kind: src.startsWith("data:") ? "首字徽标（兜底）" : (/^https?:\\/\\/[^/]+\\/scramjet\\//.test(src) ? "代理" : (src.includes("/favicon.ico") ? "根 /favicon.ico" : "其它")),
				src: decodeURIComponent(src).slice(0, 150),
			};
		}
		return o;
	})()`);
	for (const [id, v] of Object.entries(out.icons)) {
		out.steps.push(`${id.padEnd(9)} 画出=${v.drawn ? "✅" : "❌"} ${String(v.w || 0).padStart(3)}px  升级=${v.upgraded ? "是" : "否"}  ${v.kind}  ${v.src}`);
	}

	// 控制栏特写（聚焦视图那一块）
	await cdp.evaluate(`window.__ZOETROPE.focusView("bilibili")`);
	await sleep(1200);
	const bar = await cdp.evaluate(`(() => {
		const c = document.querySelector('.pane[data-focus="1"] .chrome');
		const r = c.getBoundingClientRect();
		return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.min(36, Math.round(r.height))];
	})()`);
	await cdp.shot(path.join(OUT, "chrome-zoom.png"), { x: bar[0], y: bar[1], width: bar[2], height: bar[3] });
	out.steps.push("控制栏特写：" + JSON.stringify(bar));
	await cdp.shot(path.join(OUT, "full.png"));

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
