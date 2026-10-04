#!/usr/bin/env node
/**
 * Service Worker 接管状态时间线。
 *
 * 起因：perf 采样里 `navigator.serviceWorker.controller` 等了 45 秒仍然是 null，
 * 但各视图明明在走代理。这两件事不可能同时为真，必须先弄清楚。
 *
 * 用法：HUB_URL=http://localhost:18095/ node verify/sw-state-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19830);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "sw-state");

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
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const out = { timeline: [] };
let child;
try {
	const BIN = await findBrowser();
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "zoetrope-sw-" + Date.now())}`,
		"--window-size=1400,900",
		...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
		HUB,
	], { stdio: ["ignore", "ignore", "ignore"] });

	let target = null;
	for (let i = 0; i < 60 && !target; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
		} catch {}
		if (!target) await sleep(200);
	}
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res) => ws.addEventListener("open", res, { once: true }));
	const cdp = new CDP(ws);
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");

	const t0 = Date.now();
	for (let i = 0; i < 40; i++) {
		const s = await cdp.evaluate(`(async () => {
			const r = { ctrl: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.state : null,
				now: Math.round(performance.now()),
				ready: !!(window.__ZOETROPE && window.__ZOETROPE.ready),
				regs: [] };
			try {
				for (const g of await navigator.serviceWorker.getRegistrations()) {
					r.regs.push({ scope: g.scope, active: g.active && g.active.state, installing: g.installing && g.installing.state, waiting: g.waiting && g.waiting.state });
				}
			} catch (e) { r.err = String(e); }
			try { r.stat = document.getElementById("stat")?.textContent || null; } catch {}
			try {
				r.views = ["bilibili","zhihu","douyin","coolapk"].map(id => {
					const f = document.getElementById(id === "coolapk" ? "view-coolapk" : "view-" + id);
					if (!f) return id + ":无";
					try { return id + ":" + (f.contentDocument ? f.contentDocument.readyState : "?") + "/" + ((f.contentDocument?.title||"").slice(0,10)); }
					catch { return id + ":跨源"; }
				});
			} catch {}
			return r;
		})()`);
		out.timeline.push({ t: Date.now() - t0, ...s });
		if (i % 4 === 0 || i < 6) console.log(`[${String(Date.now() - t0).padStart(6)}ms] ctrl=${s.ctrl} ready=${s.ready} regs=${JSON.stringify(s.regs)} stat=${s.stat} views=${JSON.stringify(s.views)}`);
		if (s.ctrl && s.ready) break;
		await sleep(1000);
	}
	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}
await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
console.log("fatal:", out.fatal || "-");
process.exit(0);
