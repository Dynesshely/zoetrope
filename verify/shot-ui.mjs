#!/usr/bin/env node
/**
 * 折屏布局截图器：分别出三个预设 + 两个焦点位置 + 网格总览。
 *
 * 用法：
 *   FONTCONFIG_FILE=.../tools/.fonts/fonts.conf \
 *   CHROME_ARGS="--ignore-certificate-errors" \
 *   HUB_URL=https://10.0.30.61/ node verify/shot-ui.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const PORT = Number(process.env.CDP_PORT || 19500);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "ui");
const SETTLE_MS = Number(process.env.SETTLE_MS || 40_000);

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
		this.ws = ws;
		this.seq = 0;
		this.pending = new Map();
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
			setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(method + " 超时"));
			}, 20000);
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
const out = { hub: HUB, shots: [], steps: [] };

let child;
try {
	await mkdir(OUT, { recursive: true });
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-ui-${Date.now()}`);

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

	// 等引导完成
	let ready = false;
	for (let i = 0; i < 60; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) {
			ready = true;
			break;
		}
		await sleep(1000);
	}
	out.ready = ready;
	out.steps.push("ready = " + ready);
	if (!ready) throw new Error("hub 未就绪");

	// 等内容稳定
	const deadline = Date.now() + SETTLE_MS;
	let prev = "";
	while (Date.now() < deadline) {
		const p = await cdp.evaluate("JSON.stringify(window.__ZOETROPE.probe())");
		const all = Object.values(JSON.parse(p)).every((v) => v.state !== "loading");
		if (p === prev && all) break;
		prev = p;
		await sleep(2500);
	}
	out.probe = JSON.parse(await cdp.evaluate("JSON.stringify(window.__ZOETROPE.probe())"));

	const snap = async (name) => {
		const f = path.join(OUT, `${name}.png`);
		await cdp.shot(f);
		out.shots.push(`${name}.png`);
	};

	// 三个预设（都聚焦第一个平台）
	for (const preset of ["nav", "read", "full"]) {
		await cdp.evaluate(`window.__ZOETROPE.setPreset(${JSON.stringify(preset)})`);
		await sleep(1400);
		out.steps.push(`preset=${preset} focus=${await cdp.evaluate("window.__ZOETROPE.focus")}`);
		await snap(`preset-${preset}`);
	}

	// 导航优先下换焦点，看切换后的姿态
	await cdp.evaluate(`window.__ZOETROPE.setPreset("nav")`);
	await sleep(1200);
	const ids = Object.keys(out.probe);
	for (const id of ids) {
		await cdp.evaluate(`window.__ZOETROPE.focusView(${JSON.stringify(id)})`);
		await sleep(1200);
		await snap(`focus-${id}`);
	}

	// 网格总览
	await cdp.evaluate(`window.__ZOETROPE.setMode("grid")`);
	await sleep(1600);
	await snap("grid");

	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ready: out.ready, fatal: out.fatal, steps: out.steps, shots: out.shots }, null, 2));
process.exit(out.fatal ? 1 : 0);
