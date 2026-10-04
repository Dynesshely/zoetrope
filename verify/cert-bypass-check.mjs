#!/usr/bin/env node
/**
 * 决定性实验：https 页面 + 证书不被信任，用户手动"点过警告"之后，
 * Service Worker 到底能不能注册？
 *
 * 做法：用 CDP 的 Security.setOverrideCertificateErrors + handleCertificateError
 * 精确模拟"浏览器弹出警告、用户点继续"这个状态（这不是 --ignore-certificate-errors，
 * 后者等于把证书当成有效，无法回答问题）。
 *
 * 用法：HUB_URL=https://10.0.30.61/ node verify/cert-bypass-check.mjs
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "https://10.0.30.61/";
const PORT = Number(process.env.CDP_PORT || 19240);

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
		this.ws = ws;
		this.seq = 0;
		this.pending = new Map();
		this.certErrors = [];
		this.onCertError = null;
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
				return;
			}
			if (msg.method === "Security.certificateError") {
				this.certErrors.push(msg.params);
				this.onCertError?.(msg.params);
			}
		});
	}
	send(method, params = {}) {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
			}, 20000);
		});
	}
	async evaluate(expression) {
		const r = await this.send("Runtime.evaluate", {
			expression, awaitPromise: true, returnByValue: true,
		});
		if (r.exceptionDetails) return `__EXCEPTION__ ${r.exceptionDetails.text}`;
		return r.result.value;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = { hub: HUB, steps: [] };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-bypass-${Date.now()}`);
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
		"--window-size=1280,900", "about:blank",
	], { stdio: ["ignore", "ignore", "pipe"] });

	// 等 devtools
	let target = null;
	for (let i = 0; i < 50 && !target; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
		} catch {}
		if (!target) await sleep(500);
	}
	if (!target) throw new Error("devtools 未就绪");

	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true });
		ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
	});
	const cdp = new CDP(ws);

	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	await cdp.send("Security.enable");

	// 关键：开启覆盖 —— 证书错误不弹页面，而是发事件让我们代替用户"点继续"
	await cdp.send("Security.setOverrideCertificateErrors", { override: true });
	cdp.onCertError = async (p) => {
		out.steps.push(`收到 Security.certificateError: ${p.errorType}`);
		// 这就是"用户点继续"
		await cdp.send("Security.handleCertificateError", { eventId: p.eventId, action: "continue" });
		out.steps.push("已代替用户执行 continue（等价于点过警告）");
	};

	out.steps.push(`导航到 ${HUB}`);
	await cdp.send("Page.navigate", { url: HUB });
	await sleep(6000);

	out.isSecureContext = await cdp.evaluate("window.isSecureContext");
	out.href = await cdp.evaluate("location.href");
	out.protocol = await cdp.evaluate("location.protocol");
	out.hasServiceWorkerApi = await cdp.evaluate("!!navigator.serviceWorker");

	// 直接尝试注册，拿到确切的错误名
	out.registerResult = await cdp.evaluate(`
		navigator.serviceWorker
			? navigator.serviceWorker.register('/sw.js', { scope: '/' })
				.then(r => 'REGISTER_OK  scope=' + r.scope)
				.catch(e => 'REGISTER_FAIL  ' + e.name + ': ' + e.message)
			: 'NO_SW_API'
	`);

	out.controller = await cdp.evaluate("!!navigator.serviceWorker?.controller");
	await sleep(8000);
	out.smvReady = await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)");
	out.smvError = await cdp.evaluate(
		"window.__ZOETROPE ? window.__ZOETROPE.error : (document.getElementById('boot-error')?.textContent || null)"
	);
	out.bodyHead = await cdp.evaluate("(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,220)");
	out.certErrorCount = cdp.certErrors.length;

	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
