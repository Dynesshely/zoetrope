#!/usr/bin/env node
/** 控制栏导航验证：地址栏回车 → 后退 → 前进 → 刷新，检查历史栈与真实网址。 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const VIEW = process.env.VIEW || "zhihu";
const PORT = Number(process.env.CDP_PORT || 19660);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "nav");

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
const out = { steps: [] };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-nav-${Date.now()}`);
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
		"--window-size=1280,900",
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
	await sleep(8000);

	out.initial = (await cdp.evaluate("JSON.stringify(window.__ZOETROPE.urls())"));
	out.steps.push("初始：" + out.initial);

	// 地址栏输入 + 回车
	const typed = await cdp.evaluate(`(() => {
		const el = document.querySelector('.pane[data-id="${VIEW}"] .addr');
		el.focus();
		el.value = "https://www.zhihu.com/explore";
		el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return el.value;
	})()`);
	out.steps.push("地址栏输入：" + typed);
	await sleep(9000);
	out.afterAddress = await cdp.evaluate(`JSON.stringify(window.__ZOETROPE.nav(${JSON.stringify(VIEW)}, "none"))`);
	out.titleAfter = await cdp.evaluate(`document.querySelector('.pane[data-id="${VIEW}"] iframe').contentDocument?.title`);
	out.steps.push("导航后：" + out.afterAddress + " | 标题=" + out.titleAfter);

	// 后退
	out.afterBack = await cdp.evaluate(`JSON.stringify(window.__ZOETROPE.nav(${JSON.stringify(VIEW)}, "back"))`);
	await sleep(7000);
	out.titleBack = await cdp.evaluate(`document.querySelector('.pane[data-id="${VIEW}"] iframe').contentDocument?.title`);
	out.steps.push("后退后：" + out.afterBack + " | 标题=" + out.titleBack);

	// 前进
	out.afterForward = await cdp.evaluate(`JSON.stringify(window.__ZOETROPE.nav(${JSON.stringify(VIEW)}, "forward"))`);
	await sleep(7000);
	out.titleForward = await cdp.evaluate(`document.querySelector('.pane[data-id="${VIEW}"] iframe').contentDocument?.title`);
	out.steps.push("前进后：" + out.afterForward + " | 标题=" + out.titleForward);

	// 刷新
	out.afterReload = await cdp.evaluate(`JSON.stringify(window.__ZOETROPE.nav(${JSON.stringify(VIEW)}, "reload"))`);
	await sleep(6000);
	out.titleReload = await cdp.evaluate(`document.querySelector('.pane[data-id="${VIEW}"] iframe').contentDocument?.title`);
	out.steps.push("刷新后：" + out.afterReload + " | 标题=" + out.titleReload);

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
