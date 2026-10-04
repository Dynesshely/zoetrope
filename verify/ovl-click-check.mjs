#!/usr/bin/env node
/**
 * 弹层内的链接也要"原地换页"，不能弹出真的新标签页。
 *
 * 步骤：hub → 弹层打开 B 站视频页 → 在弹层里找 target=_blank 链接 → 点击
 * 断言：① 弹层地址变了 ② 主视图的 under 压层级标记还在 ③ 没有新增浏览器标签页
 *
 * 用法：HUB_URL=http://localhost:18095/ OUT_DIR=verify/ovl-click node verify/ovl-click-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19790);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "ovl-click");
const VIDEO = process.env.VIDEO || "https://www.bilibili.com/video/BV1ZDan66EdQ/";

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
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "zoetrope-ovlclick-" + Date.now())}`,
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

	const pageCount = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === "page").length;

	for (let i = 0; i < 90; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(1000);
	}
	await sleep(15000);
	const before = await pageCount();

	await cdp.evaluate(`window.__ZOETROPE.openOverlay(${JSON.stringify(VIDEO)}, "bilibili")`);
	await sleep(30000);
	out.before = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-overlay").contentDocument;
		const a = [...d.querySelectorAll('a[target="_blank"]')].find(x => { const h = x.getAttribute("href")||""; return h && !/^(javascript|mailto|tel):/i.test(h); });
		return { overlayUrl: d.location.href, title: d.title, under: [...document.querySelectorAll(".pane")].map(p=>p.dataset.id+":"+p.dataset.under), pick: a ? a.getAttribute("href") : null, blankCount: [...d.querySelectorAll('a[target="_blank"]')].length };
	})()`);
	out.steps.push("点击前：" + JSON.stringify(out.before));

	out.click = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-overlay").contentDocument;
		const a = [...d.querySelectorAll('a[target="_blank"]')].find(x => { const h = x.getAttribute("href")||""; return h && !/^(javascript|mailto|tel):/i.test(h); });
		if (!a) return "弹层里没有可点的 _blank 链接";
		a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: d.defaultView }));
		return "已点击 " + a.getAttribute("href");
	})()`);
	out.steps.push(out.click);
	await sleep(12000);

	out.after = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-overlay").contentDocument;
		return { overlayUrl: d.location.href, title: d.title, under: [...document.querySelectorAll(".pane")].map(p=>p.dataset.id+":"+p.dataset.under) };
	})()`);
	out.pages = { before, after: await pageCount() };
	out.steps.push("点击后：" + JSON.stringify(out.after));
	out.steps.push(`浏览器标签页数 before=${before} after=${out.pages.after}`);
	out.log = await cdp.evaluate(`JSON.stringify((window.__ZOETROPE.overlayLog||[]).map(x=>({k:x.kind,final:x.final})))`);
	out.steps.push("弹层调用流水：" + out.log);
	await cdp.shot(path.join(OUT, "after.png"));
	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}
await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
for (const s of out.steps) console.log("•", s);
console.log("fatal:", out.fatal || "-");
process.exit(0);
