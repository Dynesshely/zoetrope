#!/usr/bin/env node
/**
 * Logo 候选对比图。
 *
 * 16×16 才是真正的考场：96px 好看不算数，标签页上糊成一团就没用。
 * 每个候选渲染「96 底板 / 32 底板 / 16 底板 / 48 纯标记」四档，
 * 深色与浅色底各一行，直接截图肉眼挑。
 *
 * 用法：node verify/logo-candidates.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = process.cwd();
const PORT = Number(process.env.CDP_PORT || 19980);

const ACCENT = "#58a6ff";
const DIM = "#7d93ad";

/** 每个候选返回 96×96 viewBox 的内容；tile=true 时带深色底板 */
const CANDIDATES = [
	{
		name: "D1 四段环·等亮",
		mark: `
			<g fill="none" stroke-linecap="round" stroke-width="12">
				<path d="M35.1 26.6 A25 25 0 0 1 60.9 26.6" stroke="${ACCENT}"/>
				<path d="M69.4 35.1 A25 25 0 0 1 69.4 60.9" stroke="${DIM}" stroke-opacity=".5"/>
				<path d="M60.9 69.4 A25 25 0 0 1 35.1 69.4" stroke="${DIM}" stroke-opacity=".5"/>
				<path d="M26.6 60.9 A25 25 0 0 1 26.6 35.1" stroke="${DIM}" stroke-opacity=".5"/>
			</g>`,
	},
	{
		name: "D2 四段环·焦点递减",
		mark: `
			<g fill="none" stroke-linecap="round" stroke-width="12">
				<path d="M35.1 26.6 A25 25 0 0 1 60.9 26.6" stroke="${ACCENT}"/>
				<path d="M69.4 35.1 A25 25 0 0 1 69.4 60.9" stroke="${DIM}" stroke-opacity=".34"/>
				<path d="M60.9 69.4 A25 25 0 0 1 35.1 69.4" stroke="${DIM}" stroke-opacity=".5"/>
				<path d="M26.6 60.9 A25 25 0 0 1 26.6 35.1" stroke="${DIM}" stroke-opacity=".34"/>
			</g>`,
	},
	{
		name: "D3 四段环 + 中心点",
		mark: `
			<circle cx="48" cy="48" r="4.6" fill="${ACCENT}"/>
			<g fill="none" stroke-linecap="round" stroke-width="12">
				<path d="M35.1 26.6 A25 25 0 0 1 60.9 26.6" stroke="${ACCENT}"/>
				<path d="M69.4 35.1 A25 25 0 0 1 69.4 60.9" stroke="${DIM}" stroke-opacity=".34"/>
				<path d="M60.9 69.4 A25 25 0 0 1 35.1 69.4" stroke="${DIM}" stroke-opacity=".5"/>
				<path d="M26.6 60.9 A25 25 0 0 1 26.6 35.1" stroke="${DIM}" stroke-opacity=".34"/>
			</g>`,
	},
	{
		name: "D4 三段环（原 C2）",
		mark: `
			<g fill="none" stroke-linecap="round" stroke-width="11">
				<path d="M31.3 29.4 A25 25 0 0 1 64.7 29.4" stroke="${ACCENT}"/>
				<path d="M72.5 42.8 A25 25 0 0 1 55.7 71.8" stroke="${DIM}" stroke-opacity=".5"/>
				<path d="M40.3 71.8 A25 25 0 0 1 23.6 42.8" stroke="${DIM}" stroke-opacity=".5"/>
			</g>`,
	},
	{
		name: "D5 三段环 + 中心点",
		mark: `
			<circle cx="48" cy="48" r="4.6" fill="${ACCENT}"/>
			<g fill="none" stroke-linecap="round" stroke-width="11">
				<path d="M31.3 29.4 A25 25 0 0 1 64.7 29.4" stroke="${ACCENT}"/>
				<path d="M72.5 42.8 A25 25 0 0 1 55.7 71.8" stroke="${DIM}" stroke-opacity=".5"/>
				<path d="M40.3 71.8 A25 25 0 0 1 23.6 42.8" stroke="${DIM}" stroke-opacity=".5"/>
			</g>`,
	},
	{
		name: "D6 四段环·加粗缩小",
		mark: `
			<g fill="none" stroke-linecap="round" stroke-width="15">
				<path d="M35.1 26.6 A25 25 0 0 1 60.9 26.6" stroke="${ACCENT}"/>
				<path d="M69.4 35.1 A25 25 0 0 1 69.4 60.9" stroke="${DIM}" stroke-opacity=".4"/>
				<path d="M60.9 69.4 A25 25 0 0 1 35.1 69.4" stroke="${DIM}" stroke-opacity=".55"/>
				<path d="M26.6 60.9 A25 25 0 0 1 26.6 35.1" stroke="${DIM}" stroke-opacity=".4"/>
			</g>`,
	},
];

const tile = (inner, size) => `
<svg viewBox="0 0 96 96" width="${size}" height="${size}">
	<defs>
		<linearGradient id="bg${size}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#161d27"/><stop offset="1" stop-color="#0a0d12"/>
		</linearGradient>
	</defs>
	<rect width="96" height="96" rx="22" fill="url(#bg${size})"/>
	<rect x="0.9" y="0.9" width="94.2" height="94.2" rx="21.2" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="1.8"/>
	${inner}
</svg>`;

const bare = (inner, size) => `
<svg viewBox="0 0 96 96" width="${size}" height="${size}">${inner}</svg>`;

const rows = CANDIDATES.map(
	(c) => `
<tr>
	<th>${c.name}</th>
	<td>${tile(c.mark, 96)}</td>
	<td>${tile(c.mark, 32)}</td>
	<td>${tile(c.mark, 16)}</td>
	<td>${bare(c.mark, 56)}</td>
	<td class="lt">${bare(c.mark, 56)}</td>
	<td><span class="tab">${tile(c.mark, 16)} zoetrope</span></td>
</tr>`
).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
	body{margin:0;background:#0b0e13;color:#8b949e;font:12px/1.4 -apple-system,"Segoe UI","PingFang SC",sans-serif}
	table{border-collapse:collapse}
	th{text-align:left;padding:10px 18px;color:#e6edf3;font-weight:600;white-space:nowrap;border-top:1px solid #1d242e}
	td{padding:10px 14px;border-top:1px solid #1d242e;vertical-align:middle;text-align:center}
	td.lt{background:#fff;border-radius:8px}
	.tab{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;background:#1f2630;color:#e6edf3;border:1px solid #2c3542}
	svg{display:block}
</style>
<table>${rows}</table>`;

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

await mkdir(path.join(ROOT, "verify"), { recursive: true });
const BIN = await findBrowser();
const child = spawn(BIN, [
	"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${path.join(os.tmpdir(), "zoetrope-lc-" + Date.now())}`,
	"--window-size=760,760",
	"about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let target = null;
for (let i = 0; i < 80 && !target; i++) {
	try {
		target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
			(x) => x.type === "page" && x.webSocketDebuggerUrl
		);
	} catch {}
	if (!target) await sleep(300);
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
await send("Page.enable");
await send("Page.navigate", { url: "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64") });
await sleep(1500);
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
await writeFile(path.join(ROOT, "verify", "logo-candidates2.png"), Buffer.from(shot.data, "base64"));
console.log("verify/logo-candidates2.png 已生成");

child.kill("SIGKILL");
process.exit(0);
