#!/usr/bin/env node
/**
 * 弹层（子视图）加载诊断。
 *
 * 目的：区分「弹层机制本身坏了」还是「只有 B 站视频页在弹层里坏」。
 *  1. openOverlay 一个简单页面 → 能不能加载完？
 *  2. openOverlay B 站视频页 → 卡在什么状态？
 *  3. 全量网络日志 + 弹层文档里**仍未完成的资源**（阻塞解析的 script/link）
 *
 * 用法：HUB_URL=http://localhost:18095/ OUT_DIR=verify/ovl-diag node verify/overlay-diag.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19740);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "ovl-diag");
const VIDEO = process.env.VIDEO || "https://www.bilibili.com/video/BV1xMHh69EZ3/";
const SIMPLE = process.env.SIMPLE || "https://www.bilibili.com/";

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
		this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
		ws.addEventListener("message", (ev) => {
			const m = JSON.parse(ev.data);
			if (m.id && this.pending.has(m.id)) {
				const { resolve, reject } = this.pending.get(m.id);
				this.pending.delete(m.id);
				m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
				return;
			}
			if (m.method) this.events.push(m);
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
	async shot(f) {
		const r = await this.send("Page.captureScreenshot", { format: "png" });
		await writeFile(f, Buffer.from(r.data, "base64"));
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dumpExpr = (sel) => `(() => {
	const f = document.querySelector(${JSON.stringify(sel)});
	if (!f) return { err: "没有 iframe" };
	let d = null; try { d = f.contentDocument; } catch (e) { return { err: "跨源: " + e.message, src: f.getAttribute("src") }; }
	if (!d) return { err: "contentDocument 为 null", src: f.getAttribute("src") };
	const pend = [...d.querySelectorAll("script[src], link[rel=stylesheet], img")].map(e => ({
		tag: e.tagName, url: (e.src || e.href || "").slice(0, 110),
		done: e.tagName === "IMG" ? e.complete : undefined,
		ss: e.sheet !== undefined ? !!e.sheet : undefined,
	}));
	const perf = (() => { try { return d.defaultView.performance.getEntriesByType("resource").length; } catch { return -1; } })();
	return {
		src: f.getAttribute("src"),
		href: d.location.href,
		readyState: d.readyState,
		title: d.title,
		htmlLen: (d.documentElement && d.documentElement.outerHTML || "").length,
		head: (d.documentElement && d.documentElement.outerHTML || "").slice(0, 500),
		text: ((d.body && d.body.innerText) || "").slice(0, 200),
		resources: perf,
		pending: pend.slice(0, 25),
		frames: (() => { try { return d.querySelectorAll("iframe").length; } catch { return -1; } })(),
	};
})()`;

await mkdir(OUT, { recursive: true });
const out = { steps: [] };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-ovl-diag-${Date.now()}`);
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
	await cdp.send("Log.enable");
	await cdp.send("Network.enable");

	for (let i = 0; i < 90; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(1000);
	}
	await sleep(12000);
	out.steps.push("hub ready");

	// 记录事件游标，后面按区间取网络
	const mark = () => cdp.events.length;

	/* ── 实验 1：弹层打开一个简单页面 ───────────────────────── */
	let m0 = mark();
	await cdp.evaluate(`window.__ZOETROPE.openOverlay(${JSON.stringify(SIMPLE)}, "bilibili")`);
	await sleep(25000);
	out.simple = await cdp.evaluate(dumpExpr("#view-overlay"));
	out.simpleReq = cdp.events.slice(m0).filter((e) => e.method === "Network.requestWillBeSent")
		.map((e) => e.params.request.url).slice(-12);
	out.steps.push(`[1] 弹层简单页 ${SIMPLE} → readyState=${out.simple.readyState} title=${JSON.stringify(out.simple.title)} resources=${out.simple.resources}`);
	await cdp.shot(path.join(OUT, "1-simple.png"));

	/* ── 实验 2：弹层打开 B 站视频页 ─────────────────────────── */
	m0 = mark();
	await cdp.evaluate(`window.__ZOETROPE.openOverlay(${JSON.stringify(VIDEO)}, "bilibili")`);
	await sleep(40000);
	out.video = await cdp.evaluate(dumpExpr("#view-overlay"));
	const reqs = new Map();
	for (const e of cdp.events.slice(m0)) {
		if (e.method === "Network.requestWillBeSent") reqs.set(e.params.requestId, e.params.request.url);
	}
	out.videoNet = [];
	for (const e of cdp.events.slice(m0)) {
		if (e.method === "Network.responseReceived") {
			out.videoNet.push({ u: e.params.response.url.slice(0, 120), s: e.params.response.status });
		} else if (e.method === "Network.loadingFailed") {
			out.videoNet.push({ u: (reqs.get(e.params.requestId) || "").slice(0, 120), f: e.params.errorText, b: e.params.blockedReason || null });
		}
	}
	out.videoNet = out.videoNet.filter((r) => /bilibili\.com\/video|bilivideo|biliapi|upos|mcdn/.test(r.u));
	out.steps.push(`[2] 弹层视频页 → readyState=${out.video.readyState} title=${JSON.stringify(out.video.title)} htmlLen=${out.video.htmlLen} resources=${out.video.resources}`);
	out.steps.push(`[2] 视频页相关网络（${out.videoNet.length} 条）：${JSON.stringify(out.videoNet.slice(0, 15))}`);
	await cdp.shot(path.join(OUT, "2-video.png"));

	/* ── 实验 3：把弹层里的视频页也放到主视图里对比 ──────────── */
	m0 = mark();
	await cdp.evaluate(`window.__ZOETROPE.closeOverlay(); window.__ZOETROPE.go("bilibili", ${JSON.stringify(VIDEO)})`);
	await sleep(35000);
	out.inview = await cdp.evaluate(dumpExpr("#view-bilibili"));
	out.steps.push(`[3] 主视图同一个视频页 → readyState=${out.inview.readyState} title=${JSON.stringify(out.inview.title)} htmlLen=${out.inview.htmlLen}`);
	await cdp.shot(path.join(OUT, "3-inview.png"));

	out.console = cdp.events
		.filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error")
		.map((e) => e.params.entry.text.slice(0, 180)).slice(-20);

	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
for (const s of out.steps) console.log("•", s);
if (out.simple && out.simple.pending) console.log("simple pending:", JSON.stringify(out.simple.pending.slice(0, 6)));
if (out.video && out.video.pending) console.log("video pending:", JSON.stringify(out.video.pending.slice(0, 8)));
if (out.video) console.log("video head:", JSON.stringify(out.video.head).slice(0, 600));
console.log("console:", JSON.stringify(out.console));
console.log("fatal:", out.fatal || "-");
process.exit(0);
