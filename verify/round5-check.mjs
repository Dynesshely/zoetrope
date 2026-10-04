#!/usr/bin/env node
/**
 * U3 / U5 / U6 的可测断言。
 *
 * U3 展平编排：切模式后连续采样面板矩形，必须出现**中间态**（不是瞬移），并截图。
 * U5 三档节流：焦点=A / 邻位=B / 远端=C；C 档 .clip 的 content-visibility 必须是 hidden。
 * U6 视觉打磨：屏幕空间标签落在各自面板的投影范围内、摄像机变量会动、接触阴影可见。
 *
 * 用法：HUB_URL=http://localhost:18095/ OUT_DIR=verify/round5 node verify/round5-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19870);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "round5");

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

const rectsExpr = `(() => {
	const o = {};
	for (const p of document.querySelectorAll(".pane")) {
		const r = p.getBoundingClientRect();
		o[p.dataset.id] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
	}
	return o;
})()`;

await mkdir(OUT, { recursive: true });
const out = { steps: [], checks: {} };
let child;
try {
	const BIN = await findBrowser();
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "zoetrope-r5-" + Date.now())}`,
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
		if (!target) await sleep(300);
	}
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res) => ws.addEventListener("open", res, { once: true }));
	const cdp = new CDP(ws);
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");

	for (let i = 0; i < 90; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(500);
	}
	await sleep(25000); // 等四个视图都进来

	/* ── U5：三档 ───────────────────────────────────────────── */
	out.checks.tiers = await cdp.evaluate(`(() => {
		const o = {};
		for (const p of document.querySelectorAll(".pane")) {
			const fr = p.querySelector(".frame");
			o[p.dataset.id] = { tier: p.dataset.tier, frameCV: fr ? getComputedStyle(fr).contentVisibility : null };
		}
		return o;
	})()`);
	out.steps.push("U5 档位：" + JSON.stringify(out.checks.tiers));

	/* ── U6：标签 / 阴影 / 摄像机 ────────────────────────────── */
	out.checks.labels = await cdp.evaluate(`(() => {
		const o = {};
		for (const p of document.querySelectorAll(".pane")) {
			const lab = [...document.querySelectorAll(".slabel")].find(l => l.textContent === (p.querySelector(".name")||{}).textContent);
			if (!lab) { o[p.dataset.id] = "无标签"; continue; }
			const pr = p.getBoundingClientRect(), lr = lab.getBoundingClientRect();
			o[p.dataset.id] = {
				on: lab.dataset.on,
				panelCenter: [Math.round(pr.x + pr.width/2), Math.round(pr.y + pr.height/2)],
				labelCenter: [Math.round(lr.x + lr.width/2), Math.round(lr.y + lr.height/2)],
				inside: lr.x + lr.width/2 > pr.x && lr.x + lr.width/2 < pr.right && lr.y + lr.height/2 > pr.y && lr.y + lr.height/2 < pr.bottom,
			};
		}
		return o;
	})()`);
	out.steps.push("U6 屏幕空间标签：" + JSON.stringify(out.checks.labels));

	out.checks.shadow = await cdp.evaluate(`(() => {
		const on = getComputedStyle(document.querySelector('.pane[data-focus="1"] .shadow')).opacity;
		const off = getComputedStyle(document.querySelector('.pane[data-focus="0"] .shadow')).opacity;
		return { focused: on, unfocused: off };
	})()`);
	out.steps.push("U6 接触阴影 opacity：" + JSON.stringify(out.checks.shadow));

	out.checks.cameraBefore = await cdp.evaluate(`[getComputedStyle(document.getElementById("stage")).getPropertyValue("--camx"), getComputedStyle(document.getElementById("stage")).getPropertyValue("--camy")]`);
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1500, y: 900, button: "none" });
	await sleep(200); 
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 200, y: 200, button: "none" });
	await sleep(300);
	out.checks.cameraAfter = await cdp.evaluate(`[getComputedStyle(document.getElementById("stage")).getPropertyValue("--camx"), getComputedStyle(document.getElementById("stage")).getPropertyValue("--camy")]`);
	out.steps.push(`U6 摄像机：${JSON.stringify(out.checks.cameraBefore)} → ${JSON.stringify(out.checks.cameraAfter)}`);

	await cdp.shot(path.join(OUT, "focus.png"));

	/* ── U5 续：把视频放进远端档，必须被暂停 ─────────────────── */
	await cdp.evaluate(`window.__ZOETROPE.go("douyin", ${JSON.stringify(process.env.VIDEO || "https://www.bilibili.com/video/BV1ZDan66EdQ/")})`);
	await sleep(30000);
	out.checks.tierCPlaying = await cdp.evaluate(`(() => {
		const p = document.querySelector('.pane[data-id="douyin"]');
		let v = null; try { v = p.querySelector("iframe").contentDocument.querySelector("video"); } catch {}
		return { tier: p.dataset.tier, cv: getComputedStyle(p.querySelector(".frame")).contentVisibility, paused: v ? v.paused : null, rs: v ? v.readyState : null };
	})()`);
	await cdp.evaluate(`window.__ZOETROPE.focusView("bilibili"); window.__ZOETROPE.focusView("douyin"); window.__ZOETROPE.focusView("bilibili");`);
	await sleep(2500);
	out.checks.tierCPaused = await cdp.evaluate(`(() => {
		const p = document.querySelector('.pane[data-id="douyin"]');
		let v = null; try { v = p.querySelector("iframe").contentDocument.querySelector("video"); } catch {}
		return { tier: p.dataset.tier, cv: getComputedStyle(p.querySelector(".frame")).contentVisibility, paused: v ? v.paused : null, ct: v ? +v.currentTime.toFixed(1) : null };
	})()`);
	out.steps.push("U5 远端档里的视频（切档前）：" + JSON.stringify(out.checks.tierCPlaying));
	out.steps.push("U5 远端档里的视频（切档后）：" + JSON.stringify(out.checks.tierCPaused));

	/* ── U3：展平编排 ───────────────────────────────────────── */
	const folded = await cdp.evaluate(rectsExpr);
	await cdp.evaluate(`window.__ZOETROPE.setMode("grid")`);
	const flip = [];
	for (let i = 0; i < 14; i++) {
		flip.push(await cdp.evaluate(rectsExpr));
		if (i === 4) await cdp.shot(path.join(OUT, "flip-mid.png"));
		await sleep(55);
	}
	await sleep(400);
	await cdp.shot(path.join(OUT, "grid.png"));
	const grid = await cdp.evaluate(rectsExpr);

	// 中间态：至少有一帧的矩形既不等于起点也不等于终点
	const ids = Object.keys(folded);
	let movingFrames = 0;
	for (const frame of flip) {
		for (const id of ids) {
			const f = frame[id], a = folded[id], z = grid[id];
			if (f && a && z && (f[0] !== a[0] || f[1] !== a[1]) && (f[0] !== z[0] || f[1] !== z[1])) { movingFrames++; break; }
		}
	}
	out.checks.flip = { folded, grid, movingFrames, sampled: flip.length, series: flip.map((f) => f.bilibili) };
	out.steps.push(`U3 展平：采样 ${flip.length} 帧，其中 ${movingFrames} 帧处于中间态（>0 即为有编排动画）`);
	out.steps.push(`U3 bilibili 轨迹：${JSON.stringify(out.checks.flip.series)}`);

	// 回到折屏
	await cdp.evaluate(`window.__ZOETROPE.setMode("focus")`);
	await sleep(900);
	const back = await cdp.evaluate(rectsExpr);
	out.checks.backToFold = back;
	out.steps.push(`U3 折回：bilibili ${JSON.stringify(back.bilibili)}（应与折叠态 ${JSON.stringify(folded.bilibili)} 相近或按焦点环绕）`);
	await cdp.shot(path.join(OUT, "back-to-focus.png"));

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
