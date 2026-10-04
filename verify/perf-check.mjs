#!/usr/bin/env node
/**
 * 性能量化：**hub 四视图** vs **四个原生标签页**（都走同一个代理）。
 *
 * 时间基准用页面内的 `performance.now()` —— 以导航开始为 0，
 * 不依赖 CDP 连接的建立时间（上一版就是被这个坑了：等了 45 秒 SW controller）。
 *
 * 采：每个视图/标签页的首次 interactive / 首次 complete / 首次有标题。
 *
 * 用法：
 *   MODE=hub  HUB_URL=http://localhost:18095/ OUT_DIR=verify/perf-hub  node verify/perf-check.mjs
 *   MODE=tabs HUB_URL=http://localhost:18095/ OUT_DIR=verify/perf-tabs node verify/perf-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const MODE = process.env.MODE || "hub";
const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const PORT = Number(process.env.CDP_PORT || 19820);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "perf-" + MODE);
const WATCH_MS = Number(process.env.WATCH_MS || 40000);

const SITES = {
	bilibili: "https://www.bilibili.com/",
	zhihu: "https://www.zhihu.com/",
	douyin: "https://www.douyin.com/",
};

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
			setTimeout(() => { if (this.pending.delete(id)) reject(new Error(method + " 超时")); }, 60000);
		});
	}
	async evaluate(expression) {
		const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) return "__EXCEPTION__ " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
		return r.result.value;
	}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = (ids) => `(() => {
	const out = {};
	out.__hubNow = (window.__ZOETROPE && window.__ZOETROPE.timing) ? window.__ZOETROPE.timing() : null;
	for (const id of ${JSON.stringify(ids)}) {
		const f = document.getElementById("view-" + id);
		if (!f) { out[id] = { rs: "no-frame" }; continue; }
		let d = null; try { d = f.contentDocument; } catch { out[id] = { rs: "cross-origin" }; continue; }
		if (!d) { out[id] = { rs: "no-doc" }; continue; }
		out[id] = { rs: d.readyState, title: (d.title || "").slice(0, 18), nodes: d.querySelectorAll("*").length, now: Math.round(d.defaultView.performance.now()) };
	}
	return out;
})()`;

await mkdir(OUT, { recursive: true });
const out = { mode: MODE, steps: [] };
let child;
let top;
try {
	const BIN = await findBrowser();
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), `zoetrope-perf-${MODE}-` + Date.now())}`,
		"--window-size=1680,1000",
		...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
		HUB,
	], { stdio: ["ignore", "ignore", "ignore"] });

	let target = null;
	for (let i = 0; i < 100 && !target; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
		} catch {}
		if (!target) await sleep(150);
	}
	top = new CDP(new WebSocket(target.webSocketDebuggerUrl));
	await new Promise((res) => top.ws.addEventListener("open", res, { once: true }));
	await top.send("Page.enable");
	await top.send("Runtime.enable");

	const t0 = Date.now();
	if (MODE === "hub") {
		const samples = [];
		while (Date.now() - t0 < WATCH_MS) {
			const s = await top.evaluate(probe(Object.keys(SITES)));
			samples.push({ t: Date.now() - t0, ...s });
			await sleep(400);
		}
		out.samples = samples;
		const first = (id, pred) => { const s = samples.find((x) => x[id] && pred(x[id])); return s ? s.t : null; };
		out.result = {};
		for (const id of Object.keys(SITES)) {
			out.result[id] = {
				interactiveMs: first(id, (v) => v.rs === "interactive" || v.rs === "complete"),
				completeMs: first(id, (v) => v.rs === "complete" && v.title),
				titleMs: first(id, (v) => v.title),
				nodes: samples.at(-1)[id]?.nodes ?? null,
			};
		}
		out.hubTiming = samples.at(-1).__hubNow;
	} else {
		// 预热：先让 hub 页面把 SW 装好，再开四个"原生标签页"
		for (let i = 0; i < 120; i++) {
			const ok = await top.evaluate(`(async () => {
				const regs = await navigator.serviceWorker.getRegistrations();
				return regs.some(r => r.active && r.active.state === "activated");
			})()`).catch(() => false);
			if (ok) break;
			await sleep(300);
		}
		const sessions = {};
		const created = [];
		for (const [name, u] of Object.entries(SITES)) {
			const url = HUB.replace(/\/$/, "") + "/scramjet/" + encodeURIComponent(u);
			try {
				const info = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
				created.push({ name, info });
			} catch (e) { out.steps.push(name + " 创建失败 " + e.message); }
		}
		for (const { name, info } of created) {
			if (!info?.webSocketDebuggerUrl) continue;
			const c = new CDP(new WebSocket(info.webSocketDebuggerUrl));
			await new Promise((res) => c.ws.addEventListener("open", res, { once: true }));
			await c.send("Runtime.enable").catch(() => {});
			sessions[name] = c;
		}
		const t1 = Date.now();
		const samples = [];
		while (Date.now() - t1 < WATCH_MS) {
			const row = {};
			for (const [name, c] of Object.entries(sessions)) {
				row[name] = await c.evaluate(`(() => ({ rs: document.readyState, title: (document.title||"").slice(0,18), nodes: document.querySelectorAll("*").length }))()`).catch(() => null);
			}
			samples.push({ t: Date.now() - t1, ...row });
			await sleep(400);
		}
		out.samples = samples;
		const first = (id, pred) => { const s = samples.find((x) => x[id] && pred(x[id])); return s ? s.t : null; };
		out.result = {};
		for (const id of Object.keys(SITES)) {
			out.result[id] = {
				interactiveMs: first(id, (v) => v.rs === "interactive" || v.rs === "complete"),
				completeMs: first(id, (v) => v.rs === "complete" && v.title),
				titleMs: first(id, (v) => v.title),
				nodes: samples.at(-1)[id]?.nodes ?? null,
			};
		}
	}
	out.steps.push("各站点 " + MODE + "：" + JSON.stringify(out.result));
	if (out.hubTiming) out.steps.push("hub 内部分段时间： " + JSON.stringify(out.hubTiming));
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}
await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
for (const s of out.steps) console.log("•", s);
console.log("fatal:", out.fatal || "-");
process.exit(0);
