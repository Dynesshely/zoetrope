#!/usr/bin/env node
/**
 * 通用探测：在同一个标签里先加载 hub（注册 Service Worker），
 * 再导航到任意 URL 并报告标题 / 正文 / 截图。
 *
 * 用途：对照实验。例如把"抖音被代理后"分别用
 *   A) iframe 内（hub 的多视图里）
 *   B) 顶层文档（本脚本）
 * 打开，若 A 出验证码而 B 不出，说明是**框架检测**而非代理改写失败。
 *
 * 用法：
 *   TARGET='https://10.0.30.61/scramjet/https%3A%2F%2Fwww.douyin.com%2F' \
 *   node verify/inspect-url.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "https://10.0.30.61/";
const TARGET = process.env.TARGET;
const PORT = Number(process.env.CDP_PORT || 19250);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "inspect");
const WAIT_MS = Number(process.env.WAIT_MS || 20000);

if (!TARGET) {
	console.error("需要 TARGET=<url>");
	process.exit(2);
}

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
		this.ws = ws; this.seq = 0; this.pending = new Map(); this.logs = [];
		ws.addEventListener("message", (ev) => {
			const m = JSON.parse(ev.data);
			if (m.id && this.pending.has(m.id)) {
				const { resolve, reject } = this.pending.get(m.id);
				this.pending.delete(m.id);
				m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
				return;
			}
			if (m.method === "Log.entryAdded") this.logs.push(`[${m.params.entry.level}] ${m.params.entry.text}`);
			if (m.method === "Security.certificateError") {
				this.send("Security.handleCertificateError", { eventId: m.params.eventId, action: "continue" });
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
const out = { hub: HUB, target: TARGET, steps: [] };

let child;
try {
	await mkdir(OUT, { recursive: true });
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-inspect-${Date.now()}`);

	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
		"--window-size=1680,1000",
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
	await cdp.send("Log.enable");
	await cdp.send("Security.enable");
	await cdp.send("Security.setOverrideCertificateErrors", { override: true });

	// 1) 先加载 hub，让 Service Worker 注册好
	out.steps.push("加载 hub 以注册 Service Worker");
	await cdp.send("Page.navigate", { url: HUB });
	for (let i = 0; i < 40; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(1000);
	}
	out.swReady = await cdp.evaluate("!!navigator.serviceWorker?.controller || !!(await navigator.serviceWorker?.getRegistrations?.().then(r=>r.length))");
	out.steps.push("Service Worker 就绪 = " + out.swReady);

	// 2) 顶层导航到目标
	out.steps.push(`顶层导航到 ${TARGET}`);
	await cdp.send("Page.navigate", { url: TARGET });
	await sleep(WAIT_MS);

	out.finalUrl = await cdp.evaluate("location.href");
	out.title = await cdp.evaluate("document.title");
	out.nodes = await cdp.evaluate("document.querySelectorAll('*').length");
	out.text = await cdp.evaluate("(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,600)");
	out.hasCaptchaHint = await cdp.evaluate(
		"/验证|captcha|verify|拼图|滑块/i.test(document.body?.innerText||'')"
	);
	const shot = path.join(OUT, `toplevel-${Date.now()}.png`);
	await cdp.shot(shot);
	out.screenshot = shot;
	out.logs = cdp.logs.slice(-40);
	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
