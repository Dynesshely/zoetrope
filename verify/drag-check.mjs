#!/usr/bin/env node
/**
 * 拖拽探针：对比「直连」与「经 Scramjet 代理」两种情况下，
 * 页面里 JS 看到的事件是否 isTrusted，以及拖拽是否真的发生了。
 *
 * 动机：拦截式代理常需要重新派发事件，而重新派发的事件 isTrusted 会是 false，
 * 风控滑块（知乎验证码就是）恰恰会检查这个。
 *
 * 用法：
 *   node verify/drag-check.mjs            # 两种模式都跑
 *   MODE=direct  node verify/drag-check.mjs
 *   MODE=proxied node verify/drag-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const RAW = process.env.RAW_URL || "http://10.0.30.61:18096/dragtest.html";
const PROXIED =
	process.env.PROXIED_URL ||
	"http://127.0.0.1:18095/scramjet/" + encodeURIComponent(RAW);
const MODE = process.env.MODE || "both";
const PORT = Number(process.env.CDP_PORT || 19600);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "drag");

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
			setTimeout(() => { if (this.pending.delete(id)) reject(new Error(method + " 超时")); }, 20000);
		});
	}
	async evaluate(expression) {
		const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) return "__EXCEPTION__ " + r.exceptionDetails.text;
		return r.result.value;
	}
	async shot(file) {
		const r = await this.send("Page.captureScreenshot", { format: "png" });
		await writeFile(file, Buffer.from(r.data, "base64"));
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在给定坐标处做一次"人手式"拖拽：按下 → 多次小幅移动 → 抬起 */
async function drag(cdp, from, to, steps = 24) {
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1,
	});
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: from.x + (to.x - from.x) * t,
			y: from.y + (to.y - from.y) * t,
			button: "left", buttons: 1,
		});
		await sleep(16);
	}
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1,
	});
}

async function runOne(cdp, label, url, { needSW }) {
	const rec = { label, url };
	// 每个模式用一次干净导航；代理模式依赖已注册的 SW
	await cdp.send("Page.navigate", { url: needSW ? HUB : "about:blank" });
	await sleep(needSW ? 6000 : 500);
	if (needSW) {
		for (let i = 0; i < 40; i++) {
			if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
			await sleep(1000);
		}
	}
	await cdp.send("Page.navigate", { url });
	await sleep(4000);

	rec.title = await cdp.evaluate("document.title");
	rec.hasProbe = await cdp.evaluate("typeof window.__DRAG === 'function'");
	if (!rec.hasProbe) {
		rec.note = "探针脚本未运行（页面可能没加载成功）";
		rec.bodyText = await cdp.evaluate("(document.body?.innerText||'').slice(0,200)");
		return rec;
	}

	const rect = await cdp.evaluate(
		"JSON.stringify((()=>{const r=document.getElementById('knob').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})())"
	);
	const r = JSON.parse(rect);
	const from = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
	const to = { x: from.x + 240, y: from.y };

	await drag(cdp, from, to);
	await sleep(400);

	rec.result = await cdp.evaluate("JSON.stringify(window.__DRAG())");
	rec.shot = path.join(OUT, `drag-${label}.png`);
	await cdp.shot(rec.shot);
	return rec;
}

await mkdir(OUT, { recursive: true });
const out = { raw: RAW, proxied: PROXIED, results: [] };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-drag-${Date.now()}`);
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
		"--window-size=1280,900",
		...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
		"about:blank",
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

	if (MODE === "direct" || MODE === "both") {
		out.results.push(await runOne(cdp, "direct", RAW, { needSW: false }));
	}
	if (MODE === "proxied" || MODE === "both") {
		out.results.push(await runOne(cdp, "proxied", PROXIED, { needSW: true }));
	}
	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
for (const r of out.results) {
	console.log(`\n===== ${r.label} =====`);
	if (r.note) { console.log("note:", r.note, "| body:", r.bodyText); continue; }
	const d = JSON.parse(r.result);
	console.log("counts :", JSON.stringify(d.counts));
	console.log("trusted:", JSON.stringify(d.trusted));
	console.log("knobLeft =", d.knobLeft, "| rangeValue =", d.rangeValue);
}
console.log("\nfatal:", out.fatal || "-");
process.exit(0);
