#!/usr/bin/env node
/**
 * 把 docs/images/logo.svg 渲染成各尺寸 PNG（favicon / apple-touch-icon），
 * 并生成一张**预览图**（浅色 / 深色底 + 16/32/96px），用来肉眼验收 Logo。
 *
 * 本机没有 imagemagick / rsvg / cwebp，所以还是借无头 Chromium 的 canvas。
 *
 * 用法：node verify/logo-render.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = process.cwd();
const SVG = path.join(ROOT, "docs", "images", "logo.svg");
const PORT = Number(process.env.CDP_PORT || 19970);

const PNG_JOBS = [
	{ out: "proxy/public/favicon.png", size: 64 },
	{ out: "proxy/public/apple-touch-icon.png", size: 180 },
];

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const svg = await readFile(SVG, "utf8");
const svgB64 = Buffer.from(svg, "utf8").toString("base64");

// 预览页：深/浅底，16 / 32 / 64 / 96 四档
const previewHtml = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .row{display:flex;align-items:flex-end;gap:26px;padding:26px 34px}
  .dark{background:#0b0e13;color:#8b949e}
  .light{background:#ffffff;color:#6b7280}
  .cell{display:flex;flex-direction:column;align-items:center;gap:8px}
  img{display:block;image-rendering:auto}
  .sep{height:1px;background:#2a3341}
  .tab{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;font-size:12px;margin-left:14px}
  .tab.d{background:#1f2630;color:#e6edf3;border:1px solid #2c3542}
  .tab.l{background:#f1f3f5;color:#24292f;border:1px solid #d0d7de}
</style>
<div class="row dark">
  <div class="cell"><img src="data:image/svg+xml;base64,${svgB64}" width="96" height="96"><span>96</span></div>
  <div class="cell"><img src="data:image/svg+xml;base64,${svgB64}" width="64" height="64"><span>64</span></div>
  <div class="cell"><img src="data:image/svg+xml;base64,${svgB64}" width="32" height="32"><span>32</span></div>
  <div class="cell"><img src="data:image/svg+xml;base64,${svgB64}" width="16" height="16"><span>16</span></div>
  <span class="tab d"><img src="data:image/svg+xml;base64,${svgB64}" width="16" height="16">zoetrope · 西洋镜</span>
</div>
<div class="sep"></div>
<div class="row light">
  <div class="cell"><img src="data:image/svg+xml;base64,${svgB64}" width="96" height="96"><span>96</span></div>
  <div class="cell"><img src="data:image/svg+xml;base64,${svgB64}" width="64" height="64"><span>64</span></div>
  <div class="cell"><img src="data:image/svg+xml;base64,${svgB64}" width="32" height="32"><span>32</span></div>
  <div class="cell"><img src="data:image/svg+xml;base64,${svgB64}" width="16" height="16"><span>16</span></div>
  <span class="tab l"><img src="data:image/svg+xml;base64,${svgB64}" width="16" height="16">zoetrope · 西洋镜</span>
</div>`;

await mkdir(path.join(ROOT, "verify"), { recursive: true });
const BIN = await findBrowser();
const child = spawn(BIN, [
	"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${path.join(os.tmpdir(), "zoetrope-logo-" + Date.now())}`,
	"--window-size=900,420",
	"about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeErr = "";
child.stderr.on("data", (d) => { chromeErr += d.toString(); });

let target = null;
for (let i = 0; i < 80 && !target; i++) {
	try {
		target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
			(x) => x.type === "page" && x.webSocketDebuggerUrl
		);
	} catch {}
	if (!target) await sleep(300);
}
if (!target) {
	console.error("未能连上 chrome。stderr:\n" + chromeErr.slice(-1500));
	child.kill("SIGKILL");
	process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener("message", (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pend.has(m.id)) {
		const { res, rej } = pend.get(m.id);
		pend.delete(m.id);
		m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
	}
});
const send = (method, params = {}) =>
	new Promise((res, rej) => {
		const id = ++seq;
		pend.set(id, { res, rej });
		ws.send(JSON.stringify({ id, method, params }));
		setTimeout(() => { if (pend.delete(id)) rej(new Error(method + " 超时")); }, 30000);
	});
const ev = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
	return r.result.value;
};
await send("Page.enable");
await send("Runtime.enable");

// 1) 各尺寸 PNG
for (const job of PNG_JOBS) {
	const data = await ev(`(async () => {
		const img = new Image();
		img.src = "data:image/svg+xml;base64," + ${JSON.stringify(svgB64)};
		await img.decode();
		const c = document.createElement("canvas");
		c.width = ${job.size}; c.height = ${job.size};
		const g = c.getContext("2d");
		g.drawImage(img, 0, 0, ${job.size}, ${job.size});
		return c.toDataURL("image/png").split(",")[1];
	})()`);
	const buf = Buffer.from(data, "base64");
	await writeFile(path.join(ROOT, job.out), buf);
	console.log(`${job.out.padEnd(34)} ${job.size}×${job.size}  ${(buf.length / 1024).toFixed(1)} KB`);
}

// 2) 预览图
await send("Page.navigate", { url: "data:text/html;base64," + Buffer.from(previewHtml, "utf8").toString("base64") });
await sleep(1500);
const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(path.join(ROOT, "verify", "logo-preview.png"), Buffer.from(shot.data, "base64"));
console.log("verify/logo-preview.png               预览图已生成");

child.kill("SIGKILL");
process.exit(0);
