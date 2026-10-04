#!/usr/bin/env node
/**
 * zoetrope — 无头验证脚本
 *
 * 用宿主上已有的 Playwright 缓存二进制 chrome-headless-shell，经 CDP：
 *   1. 打开 hub 页面
 *   2. 等 Scramjet 内核就绪
 *   3. 逐平台探测 iframe 内真实 DOM（同源，因为内容都由本域 Service Worker 服务）
 *   4. 逐平台截图 + 宫格截图
 *   5. 输出 JSON 结果
 *
 * 不用 Playwright/puppeteer，只需要 Node 内置的 fetch 与 WebSocket。
 *
 * 用法：HUB_URL=http://127.0.0.1:18095/ node verify/cdp-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const PORT = Number(process.env.CDP_PORT || 19222);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "out");
const SHOTS = path.join(OUT, "shots");
const BOOT_BUDGET_MS = Number(process.env.BOOT_BUDGET_MS || 60_000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 45_000);

/* ------------------------------------------------------------ 定位浏览器 */

async function findBrowser() {
	if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
		return process.env.CHROME_BIN;
	}
	const root = path.join(os.homedir(), ".cache", "ms-playwright");
	if (!existsSync(root)) throw new Error(`找不到 ${root}`);
	for (const dir of (await readdir(root)).sort().reverse()) {
		if (!dir.startsWith("chromium_headless_shell")) continue;
		const p = path.join(
			root,
			dir,
			"chrome-headless-shell-linux64",
			"chrome-headless-shell"
		);
		if (existsSync(p)) return p;
	}
	throw new Error("ms-playwright 下没有 chrome-headless-shell");
}

/* -------------------------------------------------------------- CDP 客户端 */

class CDP {
	constructor(ws) {
		this.ws = ws;
		this.seq = 0;
		this.pending = new Map();
		this.logs = [];
		this.reqUrl = new Map();
		ws.addEventListener("message", (ev) => {
			let msg;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
				return;
			}
			if (msg.method === "Network.requestWillBeSent") {
				this.reqUrl.set(msg.params.requestId, msg.params.request.url);
			}
			if (msg.method === "Network.loadingFailed") {
				const p = msg.params;
				const url = this.reqUrl.get(p.requestId) || "?";
				this.logs.push(
					`[netfail] type=${p.type} error=${p.errorText}` +
						(p.blockedReason ? ` blocked=${p.blockedReason}` : "") +
						` url=${url}`
				);
			}
			if (msg.method === "Log.entryAdded") {
				const e = msg.params.entry;
				this.logs.push(`[log:${e.level}] ${e.text}${e.url ? " @ " + e.url : ""}`);
			}
			if (msg.method === "Runtime.exceptionThrown") {
				const d = msg.params.exceptionDetails;
				this.logs.push(`[exception] ${d.text} ${d.exception?.description || ""}`);
			}
			if (msg.method === "Runtime.consoleAPICalled") {
				const txt = (msg.params.args || [])
					.map((a) => a.value ?? a.description ?? a.type)
					.join(" ");
				this.logs.push(`[console:${msg.params.type}] ${txt}`);
			}
		});
	}

	send(method, params = {}) {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
			}, 20_000);
		});
	}

	async evaluate(expression) {
		const r = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (r.exceptionDetails) {
			throw new Error(
				`evaluate 异常: ${r.exceptionDetails.text} ${
					r.exceptionDetails.exception?.description || ""
				}`
			);
		}
		return r.result.value;
	}

	async shot(file) {
		const r = await this.send("Page.captureScreenshot", { format: "png" });
		await writeFile(file, Buffer.from(r.data, "base64"));
		return file;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, { budget, every = 1000, label = "条件" }) {
	const deadline = Date.now() + budget;
	let last;
	for (;;) {
		try {
			last = await check();
			if (last) return last;
		} catch (e) {
			last = e;
		}
		if (Date.now() > deadline) return null;
		await sleep(every);
	}
}

/* ------------------------------------------------------------------- 主流程 */

const result = {
	hub: HUB,
	startedAt: new Date().toISOString(),
	browser: null,
	booted: false,
	bootError: null,
	probe: null,
	shots: [],
	logs: [],
	platforms: {},
};

let child;
try {
	const BIN = await findBrowser();
	result.browser = BIN;
	await mkdir(SHOTS, { recursive: true });

	const profile = path.join(os.tmpdir(), `zoetrope-cdp-${Date.now()}`);
	child = spawn(
		BIN,
		[
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--remote-debugging-port=" + PORT,
			"--user-data-dir=" + profile,
			"--window-size=1680,1000",
			// 例如 CHROME_ARGS="--ignore-certificate-errors" 用于自签证书的 HTTPS 验证
			...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
			HUB,
		],
		{ stdio: ["ignore", "pipe", "pipe"] }
	);
	child.stderr.on("data", (d) => {
		const s = d.toString().trim();
		if (s) result.logs.push(`[chrome] ${s.slice(0, 400)}`);
	});

	// 等 devtools 端点
	const target = await waitFor(
		async () => {
			const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
			const list = await res.json();
			return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
		},
		{ budget: 25_000, label: "devtools" }
	);
	if (!target) throw new Error("chrome devtools 端点未就绪");

	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", () => reject(new Error("ws 连接失败")), { once: true });
	});
	const cdp = new CDP(ws);
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	await cdp.send("Log.enable");
	await cdp.send("Network.enable");

	// 等 hub 的 JS 引导完成
	const booted = await waitFor(
		() => cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)"),
		{ budget: BOOT_BUDGET_MS, every: 1000, label: "__ZOETROPE.ready" }
	);
	result.booted = !!booted;

	if (!booted) {
		result.bootError = await cdp
			.evaluate(
				"window.__ZOETROPE ? window.__ZOETROPE.error : (document.getElementById('boot-error')?.textContent || 'unknown')"
			)
			.catch((e) => String(e));
		await cdp.shot(path.join(SHOTS, "00-boot-failed.png"));
		result.shots.push("00-boot-failed.png");
	} else {
		// 让各平台自己加载与稳定
		let prev = "";
		const settled = await waitFor(
			async () => {
				const p = await cdp.evaluate("JSON.stringify(window.__ZOETROPE.probe())");
				const done = JSON.parse(p);
				const all = Object.values(done).every((v) => v.state !== "loading");
				if (p === prev && all) return done;
				prev = p;
				return all ? done : null;
			},
			{ budget: SETTLE_MS, every: 3000, label: "平台加载" }
		);
		result.probe = settled || JSON.parse(await cdp.evaluate("JSON.stringify(window.__ZOETROPE.probe())"));

		// 默认焦点态（第一个平台，满屏）
		await sleep(1500);
		await cdp.shot(path.join(SHOTS, "00-hub-focus.png"));
		result.shots.push("00-hub-focus.png");

		// 逐平台截图（切焦点 → 等一帧 → 截图）
		for (const id of Object.keys(result.probe)) {
			await cdp.evaluate(`window.__ZOETROPE.focusView(${JSON.stringify(id)})`);
			await sleep(2500);
			const name = `view-${id}.png`;
			await cdp.shot(path.join(SHOTS, name));
			result.shots.push(name);
		}

		// 宫格模式：确认多视图同时存活
		await cdp.evaluate("window.__ZOETROPE.setMode('grid')");
		await sleep(3000);
		await cdp.shot(path.join(SHOTS, "grid.png"));
		result.shots.push("grid.png");
	}

	result.logs = result.logs.concat(cdp.logs);
	ws.close();
} catch (e) {
	result.fatal = String(e?.stack || e);
} finally {
	if (child) {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
}

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
await writeFile(path.join(OUT, "console.log"), result.logs.join("\n"));

// 只打印摘要，完整日志在 verify/out/ 下
const probe = result.probe || {};
console.log(`hub      : ${result.hub}`);
console.log(`booted   : ${result.booted}${result.bootError ? "  bootError=" + result.bootError : ""}`);
console.log(`fatal    : ${result.fatal || "-"}`);
console.log(`logs     : ${result.logs.length} 条 → ${path.join(OUT, "console.log")}`);
console.log(`shots    : ${result.shots.join(", ")}`);
console.log("");
for (const [id, v] of Object.entries(probe)) {
	console.log(
		`${id.padEnd(12)} ${String(v.state).padEnd(8)} nodes=${String(v.nodes).padEnd(6)} title=${JSON.stringify(v.title)}`
	);
}
process.exit(result.fatal ? 1 : 0);
