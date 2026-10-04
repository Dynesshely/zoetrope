#!/usr/bin/env node
/**
 * 弹层播放视频的**可视**验证：把弹层区域单独裁一张图，并 dump 关键 DOM。
 *
 * 用法：HUB_URL=http://localhost:18095/ OUT_DIR=verify/ovl-shot node verify/overlay-shot.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19770);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "ovl-shot");
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
	async shot(f, clip) {
		const r = await this.send("Page.captureScreenshot", clip ? { format: "png", clip: { ...clip, scale: 1 } } : { format: "png" });
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
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "zoetrope-ovlshot-" + Date.now())}`,
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
	await sleep(15000);

	await cdp.evaluate(`window.__ZOETROPE.openOverlay(${JSON.stringify(VIDEO)}, "bilibili")`);
	out.steps.push("已开弹层");
	await sleep(30000);

	out.diag = await cdp.evaluate(`(() => {
		const ifr = document.getElementById("view-overlay");
		const ovl = document.getElementById("overlay");
		const d = ifr.contentDocument;
		const r = ovl.getBoundingClientRect();
		const vids = [...d.querySelectorAll("video")].map(v => {
			const b = v.getBoundingClientRect();
			return { rs: v.readyState, ct: +v.currentTime.toFixed(1), dur: v.duration, w: v.videoWidth, rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], vis: getComputedStyle(v).visibility, disp: getComputedStyle(v).display };
		});
		const pl = d.querySelector(".bpx-player-video-wrap, #bilibili-player, .bpx-player-container");
		const pb = pl ? pl.getBoundingClientRect() : null;
		return {
			overlayRect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
			iframeUrl: d.location.href.slice(0, 90),
			title: d.title,
			readyState: d.readyState,
			playerEl: pl ? pl.className : null,
			playerRect: pb ? [Math.round(pb.x), Math.round(pb.y), Math.round(pb.width), Math.round(pb.height)] : null,
			videos: vids,
			videoCount: d.querySelectorAll("video").length,
			hasMse: typeof d.defaultView.MediaSource !== "undefined",
			ovlZ: getComputedStyle(ovl).zIndex,
			ovlOpacity: getComputedStyle(ovl).opacity,
			iframeBg: getComputedStyle(ifr).backgroundColor,
			overlayLog: (window.__ZOETROPE.overlayLog||[]).slice(-4).map(x=>({k:x.kind,final:x.final})),
		};
	})()`);
	out.steps.push("弹层诊断：" + JSON.stringify(out.diag));

	await cdp.shot(path.join(OUT, "full.png"));
	if (out.diag && out.diag.overlayRect) {
		const [x, y, w, h] = out.diag.overlayRect;
		await cdp.shot(path.join(OUT, "overlay-only.png"), { x, y, width: w, height: h });
	}
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
