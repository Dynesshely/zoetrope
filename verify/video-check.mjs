#!/usr/bin/env node
/**
 * B 站视频播放诊断：同一台机器上对比两条路径
 *
 *   MODE=toplevel  顶层标签页直接打开反代 URL（用户说"这样能播"）
 *   MODE=hub       hub 里的 bilibili 视图内导航到同一个视频
 *   MODE=overlay   hub 里用页内弹层（子视图）打开同一个视频
 *
 * 采集：<video> 的 readyState/networkState/error、播放器容器、
 *       bilivideo/mcdn 分片请求的成败、控制台报错、截图。
 *
 * 用法：
 *   MODE=hub HUB_URL=http://localhost:18095/ OUT_DIR=verify/vid-hub node verify/video-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const MODE = process.env.MODE || "hub";
const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19720);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "vid-" + MODE);
const BV = process.env.BV || "BV1xMHh69EZ3";
const VIDEO = `https://www.bilibili.com/video/${BV}/`;
const WAIT_MS = Number(process.env.WAIT_MS || 30000);

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

/** 在给定 document 表达式里探测视频状态 */
function probeExpr(docExpr) {
	return `(() => {
		let d; try { d = ${docExpr}; } catch (e) { return { err: "无法访问文档: " + e.message }; }
		if (!d) return { err: "文档为空(null)" };
		const vs = [...d.querySelectorAll("video")];
		const body = (d.body && d.body.innerText || "").slice(0, 400);
		return {
			title: d.title,
			url: d.location.href,
			readyState: d.readyState,
			videos: vs.map(v => ({
				rs: v.readyState, ns: v.networkState, paused: v.paused,
				dur: v.duration, ct: v.currentTime,
				w: v.videoWidth, h: v.videoHeight,
				err: v.error ? { code: v.error.code, msg: v.error.message } : null,
				src: (v.currentSrc || v.src || "").slice(0, 120),
			})),
			blobSrc: [...d.querySelectorAll("source")].map(s => (s.src || "").slice(0, 80)),
			player: !!d.querySelector(".bpx-player-video-wrap, .bpx-player-container"),
			mses: (() => { try { return d.querySelectorAll("video").length; } catch { return -1; } })(),
			text: body.replace(/\\s+/g, " ").slice(0, 300),
		};
	})()`;
}

await mkdir(OUT, { recursive: true });
const out = { mode: MODE, video: VIDEO, steps: [] };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-vid-${MODE}-${Date.now()}`);
	// ⚠️ 顶层模式也必须先开一次 hub：Scramjet 的 Service Worker 是由 hub 页面注册的，
	// 冷 profile 下直接开 /scramjet/... 没有 SW 接管，服务器只会回 "not found"。
	const startUrl = HUB;
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
		"--window-size=1680,1000",
		...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
		startUrl,
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
	await cdp.send("Security.enable");
	await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true });

	if (MODE === "toplevel") {
		// 等 SW 接管（hub 已注册），再把整个标签页导航到反代 URL
		for (let i = 0; i < 60; i++) {
			if (await cdp.evaluate("!!navigator.serviceWorker.controller")) break;
			await sleep(1000);
		}
		out.steps.push("SW 接管=" + (await cdp.evaluate("!!navigator.serviceWorker.controller")));
		const enc = HUB.replace(/\/$/, "") + "/scramjet/" + encodeURIComponent(VIDEO);
		await cdp.send("Page.navigate", { url: enc });
		out.steps.push("顶层标签页导航到反代 URL：" + enc);
	} else {
		// 等 hub 就绪
		for (let i = 0; i < 90; i++) {
			if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
			await sleep(1000);
		}
		out.steps.push("hub ready=" + (await cdp.evaluate("!!(window.__ZOETROPE||{}).ready")));
		// 让传输层先热起来，再动 bilibili 视图
		await sleep(12000);

		if (MODE === "hub") {
			// 走用户真实路径：往 bilibili 视图的地址栏敲回车
			out.nav = await cdp.evaluate(`(() => {
				const inp = document.querySelector("#view-bilibili").closest(".pane").querySelector(".addr");
				inp.value = ${JSON.stringify(VIDEO)};
				inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
				return "已提交 " + inp.value;
			})()`);
			out.steps.push(out.nav);
		} else {
			out.nav = await cdp.evaluate(`(() => {
				if (!window.__ZOETROPE.openOverlay) return "openOverlay 未暴露";
				window.__ZOETROPE.openOverlay(${JSON.stringify(VIDEO)}, "bilibili");
				return "已调用 openOverlay";
			})()`);
			out.steps.push(out.nav);
		}
	}

	// 每 5s 采样一次
	out.samples = [];
	const t0 = Date.now();
	while (Date.now() - t0 < WAIT_MS) {
		await sleep(5000);
		const docExpr = MODE === "toplevel"
			? "document"
			: (MODE === "hub"
				? "document.getElementById('view-bilibili').contentDocument"
				: "document.getElementById('view-overlay').contentDocument");
		const p = await cdp.evaluate(probeExpr(docExpr));
		out.samples.push({ t: Math.round((Date.now() - t0) / 1000), p });
		const v = p && p.videos && p.videos[0];
		console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, p && p.err ? p.err : JSON.stringify({ title: p.title, rs: p.readyState, v }));
	}

	const docExpr = MODE === "toplevel"
		? "document"
		: (MODE === "hub"
			? "document.getElementById('view-bilibili').contentDocument"
			: "document.getElementById('view-overlay').contentDocument");
	out.final = await cdp.evaluate(probeExpr(docExpr));
	await cdp.shot(path.join(OUT, "shot.png"));

	// 网络：分片/CDN 请求
	const reqs = new Map();
	for (const e of cdp.events) {
		if (e.method === "Network.requestWillBeSent") reqs.set(e.params.requestId, e.params.request.url);
	}
	const interesting = [];
	for (const e of cdp.events) {
		if (e.method === "Network.responseReceived") {
			const u = e.params.response.url;
			if (/bilivideo|mcdn|akamai|upos|biliapi|hdslb/.test(u)) {
				interesting.push({ url: u.slice(0, 130), status: e.params.response.status, mime: e.params.response.mimeType });
			}
		}
		if (e.method === "Network.loadingFailed") {
			const u = reqs.get(e.params.requestId) || "";
			if (/bilivideo|mcdn|upos|hdslb/.test(u)) {
				interesting.push({ url: u.slice(0, 130), failed: e.params.errorText, blocked: e.params.blockedReason || null });
			}
		}
	}
	out.net = interesting.slice(-60);
	const byStatus = {};
	for (const r of out.net) {
		const k = r.failed ? "FAIL:" + r.failed : String(r.status);
		byStatus[k] = (byStatus[k] || 0) + 1;
	}
	out.steps.push("CDN 请求状态分布：" + JSON.stringify(byStatus));

	// 控制台报错
	out.console = cdp.events
		.filter((e) => e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level))
		.map((e) => e.params.entry.level + ": " + e.params.entry.text.slice(0, 200))
		.slice(-30);
	out.consoleErrors = cdp.events
		.filter((e) => e.method === "Runtime.exceptionThrown")
		.map((e) => (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || "").slice(0, 200))
		.slice(-20);

	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
console.log("---");
console.log("final:", JSON.stringify(out.final && (out.final.err || { title: out.final.title, videos: out.final.videos })));
for (const s of out.steps) console.log("•", s);
console.log("console errors:", JSON.stringify(out.consoleErrors));
console.log("fatal:", out.fatal || "-");
process.exit(0);
