#!/usr/bin/env node
/**
 * 把 verify/ 下的验证截图转成 README 用的 WebP（本机没有 imagemagick / cwebp，
 * 就用无头 Chromium 的 canvas 做缩放 + 编码）。
 *
 * 用法：node verify/doc-images.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const OUT_DIR = path.join(process.cwd(), "docs", "images");
const PORT = Number(process.env.CDP_PORT || 19960);
const WIDTH = Number(process.env.WIDTH || 1440);
const QUALITY = Number(process.env.QUALITY || 0.88);

const JOBS = [
	{ src: "verify/ui8/preset-full.png", out: "fold-full.webp" },
	{ src: "verify/ui8/focus-bilibili.png", out: "fold-focus.webp" },
	{ src: "verify/ui8/preset-read.png", out: "fold-read.webp" },
	{ src: "verify/ui8/grid.png", out: "grid.webp" },
	{ src: "verify/round4/popout-open.png", out: "popout.webp" },
	{ src: "verify/round5c/flip-mid.png", out: "flip.webp" },
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

await mkdir(OUT_DIR, { recursive: true });
const BIN = await findBrowser();
const child = spawn(BIN, [
	"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${path.join(os.tmpdir(), "zoetrope-docimg-" + Date.now())}`,
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
		setTimeout(() => { if (pend.delete(id)) rej(new Error(method + " 超时")); }, 60000);
	});
await send("Runtime.enable");

for (const job of JOBS) {
	if (!existsSync(job.src)) {
		console.log(`跳过（不存在）${job.src}`);
		continue;
	}
	const b64 = (await readFile(job.src)).toString("base64");
	const out = await send("Runtime.evaluate", {
		awaitPromise: true,
		returnByValue: true,
		expression: `(async () => {
			const img = new Image();
			img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
			await img.decode();
			const w = ${WIDTH}, h = Math.round(img.height * w / img.width);
			const c = document.createElement("canvas");
			c.width = w; c.height = h;
			const g = c.getContext("2d");
			g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
			g.drawImage(img, 0, 0, w, h);
			return { data: c.toDataURL("image/webp", ${QUALITY}).split(",")[1], w, h };
		})()`,
	});
	if (out.exceptionDetails) {
		console.log(`失败 ${job.src}: ${out.exceptionDetails.text}`);
		continue;
	}
	const buf = Buffer.from(out.result.value.data, "base64");
	const dst = path.join(OUT_DIR, job.out);
	await writeFile(dst, buf);
	console.log(`${job.out.padEnd(18)} ${out.result.value.w}×${out.result.value.h}  ${(buf.length / 1024).toFixed(0)} KB   ← ${job.src}`);
}

child.kill("SIGKILL");
process.exit(0);
