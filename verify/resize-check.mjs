#!/usr/bin/env node
/**
 * 拖拽改尺寸的功能验证：真的用 CDP 派发鼠标事件去拖面板右下角的把手，
 * 看尺寸有没有变、面板是否仍然居中、刷新后有没有持久化。
 *
 * 用法：HUB_URL=http://127.0.0.1:18095/ node verify/resize-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const VIEW = process.env.VIEW || "bilibili";
const PORT = Number(process.env.CDP_PORT || 19640);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "resize");

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
	async shot(file) {
		const r = await this.send("Page.captureScreenshot", { format: "png" });
		await writeFile(file, Buffer.from(r.data, "base64"));
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const out = { view: VIEW, steps: [] };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-resize-${Date.now()}`);
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
	// 清掉可能残留的持久化尺寸，从预设开始
	await cdp.evaluate('localStorage.removeItem("zoetrope.sizes")');
	await cdp.evaluate(`window.__ZOETROPE.setPreset("nav")`);
	await cdp.evaluate(`window.__ZOETROPE.focusView(${JSON.stringify(VIEW)})`);
	await sleep(2500);

	out.before = JSON.parse(await cdp.evaluate("JSON.stringify(window.__ZOETROPE.sizes())"));

	// 面板与舞台的几何
	const geo = JSON.parse(await cdp.evaluate(`JSON.stringify((()=>{
		const pane=document.querySelector('.pane[data-id="${VIEW}"]');
		const h=pane.querySelector('.handle[data-corner="se"]');
		const stage=document.getElementById('stage');
		const pr=pane.getBoundingClientRect(), hr=h.getBoundingClientRect(), sr=stage.getBoundingClientRect();
		return { pane:{x:pr.x,y:pr.y,w:pr.width,h:pr.height},
		         handle:{x:hr.x+hr.width/2,y:hr.y+hr.height/2},
		         stage:{x:sr.x,y:sr.y,w:sr.width,h:sr.height} };
	})())`));
	out.geometry = geo;
	out.steps.push(
		`拖前：面板中心 x=${(geo.pane.x + geo.pane.w / 2).toFixed(1)}，舞台中心 x=${(geo.stage.x + geo.stage.w / 2).toFixed(1)}`
	);

	// 从右下角把手往外拖
	const from = geo.handle;
	const to = { x: from.x + 190, y: from.y + 90 };
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
	for (let i = 1; i <= 18; i++) {
		const t = i / 18;
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseMoved", x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
			button: "left", buttons: 1,
		});
		await sleep(16);
	}
	// 拖动中途截一张，确认用的是 transform 而不是实时重排
	out.midTransform = await cdp.evaluate(
		`getComputedStyle(document.querySelector('.pane[data-id="${VIEW}"]')).transform`
	);
	await cdp.shot(path.join(OUT, "dragging.png"));

	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
	await sleep(900);

	out.after = JSON.parse(await cdp.evaluate("JSON.stringify(window.__ZOETROPE.sizes())"));
	out.afterTransform = await cdp.evaluate(
		`getComputedStyle(document.querySelector('.pane[data-id="${VIEW}"]')).transform`
	);
	const geo2 = JSON.parse(await cdp.evaluate(`JSON.stringify((()=>{
		const pane=document.querySelector('.pane[data-id="${VIEW}"]');
		const stage=document.getElementById('stage');
		const pr=pane.getBoundingClientRect(), sr=stage.getBoundingClientRect();
		return { cx:pr.x+pr.width/2, cy:pr.y+pr.height/2, scx:sr.x+sr.width/2, scy:sr.y+sr.height/2, w:pr.width, h:pr.height };
	})())`));
	out.afterGeometry = geo2;
	out.centered =
		Math.abs(geo2.cx - geo2.scx) < 2 && Math.abs(geo2.cy - geo2.scy) < 2;
	await cdp.shot(path.join(OUT, "after-resize.png"));

	// 刷新页面，验证持久化
	await cdp.send("Page.navigate", { url: HUB });
	await sleep(1000);
	for (let i = 0; i < 60; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(1000);
	}
	out.afterReload = JSON.parse(await cdp.evaluate("JSON.stringify(window.__ZOETROPE.sizes())"));

	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
const b = out.before?.[VIEW], a = out.after?.[VIEW], r = out.afterReload?.[VIEW];
console.log(`拖前尺寸   : w=${b?.w} h=${b?.h} custom=${b?.custom}`);
console.log(`拖动中变换 : ${out.midTransform}`);
console.log(`拖后尺寸   : w=${a?.w} h=${a?.h} custom=${a?.custom}`);
console.log(`松手后变换 : ${out.afterTransform}`);
console.log(`刷新后尺寸 : w=${r?.w} h=${r?.h} custom=${r?.custom}`);
console.log(`仍居中     : ${out.centered}`);
console.log(`fatal      : ${out.fatal || "-"}`);
process.exit(0);
