#!/usr/bin/env node
/**
 * 信任度探针：往**真实的代理页面**（知乎）里注入事件监听器，
 * 看页面里的 JS 收到的 pointer/mouse 事件 isTrusted 是什么。
 *
 * 动机：风控滑块会检查 isTrusted。若拦截式代理重新派发事件，
 * isTrusted 会变成 false，验证必然失败。
 *
 * 代理页面与 hub 同源，所以父页面可以直接拿到 contentDocument 注入。
 *
 * 用法：HUB_URL=http://127.0.0.1:18095/ node verify/trust-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const VIEW = process.env.VIEW || "zhihu";
const PORT = Number(process.env.CDP_PORT || 19620);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "trust");

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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const out = { hub: HUB, view: VIEW };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-trust-${Date.now()}`);
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
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

	for (let i = 0; i < 60; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(1000);
	}
	// 把目标视图切到焦点，并等它稳定
	await cdp.evaluate(`window.__ZOETROPE.focusView(${JSON.stringify(VIEW)})`);
	await sleep(6000);

	// 1) 注入监听器到代理页面的 document
	out.inject = await cdp.evaluate(`(() => {
		const f = document.getElementById("view-${VIEW}");
		const d = f && f.contentDocument;
		if (!d) return "无法访问 contentDocument（跨源？）";
		const w = f.contentWindow;
		w.__EV = { counts: {}, trusted: {}, firstTs: {} };
		const rec = (type) => (e) => {
			const E = w.__EV;
			E.counts[type] = (E.counts[type] || 0) + 1;
			E.trusted[type] = E.trusted[type] || [];
			const v = e.isTrusted ? "true" : "FALSE";
			if (!E.trusted[type].includes(v)) E.trusted[type].push(v);
			if (E.firstTs[type] === undefined) E.firstTs[type] = { x: e.clientX, y: e.clientY, target: e.target && (e.target.tagName || "?") };
		};
		for (const t of ["pointerdown","pointermove","pointerup","mousedown","mousemove","mouseup","click"]) {
			d.addEventListener(t, rec(t), true);
		}
		return "注入完成，title=" + d.title;
	})()`);

	// 2) 算出目标视图在屏幕上的位置，在页面中部做一次拖拽
	const rect = await cdp.evaluate(`JSON.stringify((()=>{const r=document.getElementById("view-${VIEW}").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})())`);
	const r = JSON.parse(rect);
	const from = { x: r.x + r.w * 0.5, y: r.y + r.h * 0.35 };
	const to = { x: from.x + 180, y: from.y + 60 };

	out.viewport = r;
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
	for (let i = 1; i <= 20; i++) {
		const t = i / 20;
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved", x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
			button: "left", buttons: 1,
		});
		await sleep(16);
	}
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
	await sleep(600);

	out.events = JSON.parse(
		await cdp.evaluate(`JSON.stringify(document.getElementById("view-${VIEW}").contentWindow.__EV || {})`)
	);
	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
