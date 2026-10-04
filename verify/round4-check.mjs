#!/usr/bin/env node
/**
 * 第四轮验收：三个"弹出子视图"的入口都要能用。
 *   1. 控制栏 `⧉` 按钮 —— 把当前视图的页面在弹层里打开
 *   2. ⌥ / Ctrl 修饰键点击站内链接 —— 进弹层
 *   3. Esc 关闭 —— 并且弹层里的 <video> 必须被暂停（不能只是藏起来继续响）
 *
 * 用法：HUB_URL=http://localhost:18095/ OUT_DIR=verify/round4 node verify/round4-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19800);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "round4");
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
const out = { steps: [], checks: {} };
let child;
try {
	const BIN = await findBrowser();
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "zoetrope-r4-" + Date.now())}`,
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

	for (let i = 0; i < 90; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(1000);
	}
	await sleep(20000);

	/* ── 1. ⧉ 按钮 ─────────────────────────────────────────── */
	out.checks.btnExists = await cdp.evaluate(
		`!!document.querySelector('#view-bilibili').closest('.pane').querySelector('[data-act="popout"]')`
	);
	out.steps.push("① ⧉ 按钮存在：" + out.checks.btnExists);

	await cdp.evaluate(`(() => {
		const p = document.getElementById("view-bilibili").closest(".pane");
		if (!p.hasAttribute("data-id")) p.dataset.id = "bilibili";
		window.__ZOETROPE.focusView("bilibili");
	})()`);
	await sleep(1200);
	// 先把视图导航到视频页，这样 ⧉ 有明确的"当前页"
	await cdp.evaluate(`window.__ZOETROPE.go("bilibili", ${JSON.stringify(VIDEO)})`);
	await sleep(30000);

	out.checks.viewUrl = await cdp.evaluate(`document.getElementById("view-bilibili").contentDocument.location.href`);
	out.btnClick = await cdp.evaluate(`(() => {
		const b = document.querySelector('#view-bilibili').closest('.pane').querySelector('[data-act="popout"]');
		b.click();
		return "已点击 ⧉";
	})()`);
	await sleep(30000);
	out.checks.overlayUrl = await cdp.evaluate(`document.querySelector("#overlay .addr").value`);
	out.checks.overlayState = await cdp.evaluate(`document.getElementById("stage").dataset.overlay`);
	out.checks.video = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-overlay").contentDocument;
		const v = d.querySelector("video");
		return { title: d.title, url: d.location.href.slice(0, 80), paused: v ? v.paused : null, ct: v ? +v.currentTime.toFixed(1) : null, rs: v ? v.readyState : null };
	})()`);
	out.steps.push("② ⧉ 打开后的弹层：" + JSON.stringify(out.checks.overlayUrl));
	out.steps.push("③ 弹层里的视频：" + JSON.stringify(out.checks.video));
	await cdp.shot(path.join(OUT, "popout-open.png"));

	/* ── 2. Esc 关闭 + 视频暂停 ─────────────────────────────── */
	await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await sleep(1500);
	out.checks.afterEsc = await cdp.evaluate(`(() => ({
		overlay: document.getElementById("stage").dataset.overlay,
		videoPaused: (document.getElementById("view-overlay").contentDocument.querySelector("video")||{}).paused ?? null,
	}))()`);
	out.steps.push("④ Esc 之后：" + JSON.stringify(out.checks.afterEsc));
	await cdp.shot(path.join(OUT, "after-esc.png"));

	/* ── 3. ⌥/Ctrl 修饰键点击链接 ──────────────────────────── */
	out.checks.modClick = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-bilibili").contentDocument;
		const a = [...d.querySelectorAll("a")].find(x => /bilibili\\.com\\/(anime|live|game)\\//.test(x.getAttribute("href")||""));
		if (!a) return { err: "没找到可点的站内链接" };
		const href = a.getAttribute("href");
		a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, view: d.defaultView }));
		return { href };
	})()`);
	await sleep(12000);
	out.checks.modOverlay = await cdp.evaluate(`(() => ({
		overlay: document.getElementById("stage").dataset.overlay,
		url: document.querySelector("#overlay .addr").value,
		title: document.getElementById("view-overlay")?.contentDocument?.title || null,
	}))()`);
	out.steps.push("⑤ Ctrl+点击站内链接 → " + JSON.stringify(out.checks.modOverlay));
	await cdp.shot(path.join(OUT, "modclick.png"));

	out.checks.viewUrlUnchanged = await cdp.evaluate(`document.getElementById("view-bilibili").contentDocument.location.href`);
	out.steps.push("⑥ 主视图没有被带走：" + out.checks.viewUrlUnchanged);
	out.log = await cdp.evaluate(`JSON.stringify((window.__ZOETROPE.overlayLog||[]).map(x=>({k:x.kind,final:x.final})))`);
	out.steps.push("弹层调用流水：" + out.log);
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
