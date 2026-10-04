#!/usr/bin/env node
/**
 * 视图内弹层验证：在代理视图里找一个 target=_blank 的链接，
 * 合成一次点击，检查弹层是否打开、主视图是否被压层级、Esc 是否关闭。
 *
 * 用法：HUB_URL=http://127.0.0.1:18095/ VIEW=bilibili node verify/overlay-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const VIEW = process.env.VIEW || "bilibili";
const PORT = Number(process.env.CDP_PORT || 19690);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "overlay");

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
	async shot(f) {
		const r = await this.send("Page.captureScreenshot", { format: "png" });
		await writeFile(f, Buffer.from(r.data, "base64"));
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });
const out = { steps: [] };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-ovl-${Date.now()}`);
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
	await cdp.evaluate(`window.__ZOETROPE.focusView(${JSON.stringify(VIEW)})`);
	await sleep(14000);

	// 统计视图里有多少 target=_blank 链接
	out.blankLinks = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-${VIEW}").contentDocument;
		const as = [...d.querySelectorAll('a[target="_blank"]')];
		return { total: as.length, sample: as.slice(0,3).map(a => a.getAttribute("href")) };
	})()`);
	out.steps.push(`视图内 target=_blank 链接：${JSON.stringify(out.blankLinks)}`);

	// 合成点击第一个（用真实鼠标事件更接近用户，但会滚走；这里直接派发 click）
	out.clickResult = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-${VIEW}").contentDocument;
		const a = d.querySelector('a[target="_blank"]');
		if (!a) return "没有可点的链接";
		a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: d.defaultView }));
		return "已派发点击: " + a.getAttribute("href");
	})()`);
	out.steps.push(out.clickResult);
	await sleep(6000);

	out.overlayOpen = await cdp.evaluate(`document.getElementById("stage").dataset.overlay`);
	out.overlayUrl = await cdp.evaluate(`document.querySelector("#overlay .addr").value`);
	out.underFlags = await cdp.evaluate(
		`JSON.stringify([...document.querySelectorAll(".pane")].map(p => p.dataset.id + ":" + p.dataset.under))`
	);
	out.overlayTitle = await cdp.evaluate(
		`document.getElementById("view-overlay")?.contentDocument?.title || null`
	);
	out.steps.push(`弹层 open=${out.overlayOpen} url=${out.overlayUrl} title=${out.overlayTitle}`);
	out.steps.push("主视图 under 标记：" + out.underFlags);
	await cdp.shot(path.join(OUT, "overlay-open.png"));

	// Esc 关闭
	await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await sleep(1200);
	out.afterEsc = await cdp.evaluate(`document.getElementById("stage").dataset.overlay`);
	out.steps.push("Esc 之后 overlay=" + out.afterEsc);
	await cdp.shot(path.join(OUT, "overlay-closed.png"));

	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
for (const s of out.steps) console.log(s);
console.log("fatal:", out.fatal || "-");
process.exit(0);
