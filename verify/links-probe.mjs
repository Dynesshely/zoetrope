#!/usr/bin/env node
/**
 * 探针：B 站首页的视频卡片到底是怎么跳转的？
 *   - <a href*="/video/BV"> 有没有 target=_blank
 *   - 真按一下卡片，弹层会不会开（JS 里 window.open 的路径）
 *
 * 用法：VIEW=bilibili node verify/links-probe.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const VIEW = process.env.VIEW || "bilibili";
const PORT = Number(process.env.CDP_PORT || 19760);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "links-probe");

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
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "zoetrope-links-" + Date.now())}`,
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
	for (let i = 0; i < 60; i++) { const n = await cdp.evaluate("(()=>{const d=document.getElementById('view-"+VIEW+"')?.contentDocument; return d? d.querySelectorAll('a').length : 0})()"); if (n > 50) break; await sleep(2000); } await sleep(3000);

	out.stats = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-${VIEW}").contentDocument;
		const all = [...d.querySelectorAll("a")];
		const vid = all.filter(a => /\\/video\\/BV/.test(a.getAttribute("href") || ""));
		const tg = {};
		for (const a of vid) { const t = a.getAttribute("target") || "(none)"; tg[t] = (tg[t] || 0) + 1; }
		const anyBlank = all.filter(a => (a.getAttribute("target")||"").toLowerCase() === "_blank");
		const tb = {};
		for (const a of anyBlank) {
			const h = a.getAttribute("href") || "";
			const k = /\\/video\\/BV/.test(h) ? "video" : (h.includes("bilibili.com") ? "site" : "other");
			tb[k] = (tb[k] || 0) + 1;
		}
		return {
			totalAnchors: all.length,
			videoAnchors: vid.length,
			videoTargets: tg,
			blankTotal: anyBlank.length,
			blankKinds: tb,
			videoSample: vid.slice(0, 3).map(a => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), cls: a.className.slice(0, 40) })),
		};
	})()`);
	out.steps.push("链接统计：" + JSON.stringify(out.stats));

	// 真按一下第一张视频卡（用合成鼠标事件走捕获阶段）
	out.clicked = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-${VIEW}").contentDocument;
		const a = [...d.querySelectorAll("a")].find(x => /\\/video\\/BV/.test(x.getAttribute("href") || ""));
		if (!a) return "没有视频卡";
		const r = a.getBoundingClientRect();
		const opts = { bubbles: true, cancelable: true, view: d.defaultView, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
		a.dispatchEvent(new MouseEvent("pointerdown", opts));
		a.dispatchEvent(new MouseEvent("mousedown", opts));
		a.dispatchEvent(new MouseEvent("mouseup", opts));
		a.dispatchEvent(new MouseEvent("click", opts));
		return { href: a.getAttribute("href"), target: a.getAttribute("target") };
	})()`);
	out.steps.push("已点击视频卡：" + JSON.stringify(out.clicked));
	await sleep(8000);
	out.after = await cdp.evaluate(`(() => ({
		overlay: document.getElementById("stage").dataset.overlay,
		overlayUrl: document.querySelector("#overlay .addr").value,
		viewUrl: document.querySelector("#view-"+${JSON.stringify(VIEW)}).contentDocument.location.href,
		overlayTitle: document.getElementById("view-overlay")?.contentDocument?.title || null,
		overlayReady: document.getElementById("view-overlay")?.contentDocument?.readyState || null,
	}))()`);
	out.steps.push("点击后：" + JSON.stringify(out.after));
	out.overlayLog = await cdp.evaluate(`JSON.stringify((window.__ZOETROPE.overlayLog||[]).map(x=>({k:x.kind,raw:x.raw,final:x.final})))`);
	out.steps.push("弹层调用流水：" + out.overlayLog);

	// 等久一点，看弹层里的视频有没有真的起来
	await sleep(14000);
	out.videoState = await cdp.evaluate(`(() => {
		const d = document.getElementById("view-overlay").contentDocument;
		const v = d.querySelector("video");
		return { title: d.title, rs: d.readyState, v: v ? { rs: v.readyState, ns: v.networkState, ct: v.currentTime, dur: v.duration, w: v.videoWidth, err: v.error && v.error.message } : null };
	})()`);
	out.steps.push("弹层里的视频：" + JSON.stringify(out.videoState));
	await cdp.shot(path.join(OUT, "after-click.png"));
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
