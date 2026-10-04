#!/usr/bin/env node
/**
 * 复现：自建酷安 Web 版在 Scramjet 代理视图 / 直连视图下的会话 token 表现。
 *
 * 关注点：服务端下发的 `coolapk_web_token`（HttpOnly; SameSite=Strict; Path=/）
 * 能不能穿过 Scramjet 的 URL 重写 + cookie 罐，最终作为 `Cookie` 头回到服务端。
 *
 * 用法：
 *   MODE=proxied node verify/ck-scram-check.mjs
 *   MODE=direct  node verify/ck-scram-check.mjs
 *   TARGET=http://127.0.0.1:17520/ HUB=http://127.0.0.1:18095/ ...
 *
 * 输出：verify/ck-scram-<MODE>/result.json
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const MODE = process.env.MODE || "proxied";
const TARGET = process.env.TARGET || "http://127.0.0.1:17520/";
const PORT = Number(process.env.CDP_PORT || 19444);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", `ck-scram-${MODE}`);
const BOOT_BUDGET_MS = 60_000;
const SETTLE_MS = 40_000;

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
		this.logs = [];
		this.net = [];
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
			const p = msg.params;
			if (msg.method === "Network.requestWillBeSent") {
				this.reqUrl.set(p.requestId, p.request.url);
				if (/\/api\/|:17520|:17521/.test(p.request.url)) {
					this.net.push({
						kind: "request",
						id: p.requestId,
						url: p.request.url,
						method: p.request.method,
						origin: p.request.headers?.Origin ?? null,
						referer: p.request.headers?.Referer ?? null,
						cookie: p.request.headers?.Cookie ?? null,
						headers: p.request.headers,
					});
				}
			}
			if (msg.method === "Network.responseReceived" && /\/api\/|:17520|:17521/.test(p.response.url)) {
				this.net.push({
					kind: "response",
					id: p.requestId,
					url: p.response.url,
					status: p.response.status,
					setCookie: p.response.headers?.["set-cookie"] ?? p.response.headers?.["Set-Cookie"] ?? null,
				});
			}
			if (msg.method === "Network.loadingFailed") {
				this.logs.push(`[netfail] ${p.errorText} url=${this.reqUrl.get(p.requestId) || "?"}`);
			}
			if (msg.method === "Runtime.consoleAPICalled") {
				const txt = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
				this.logs.push(`[console:${p.type}] ${txt}`);
			}
			if (msg.method === "Runtime.exceptionThrown") {
				this.logs.push(`[exception] ${p.exceptionDetails.text} ${p.exceptionDetails.exception?.description || ""}`);
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
			}, 30_000);
		});
	}
	async evaluate(expression) {
		const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) {
			throw new Error(`evaluate 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ""}`);
		}
		return r.result.value;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, { budget, every = 1000 }) {
	const deadline = Date.now() + budget;
	for (;;) {
		try {
			const v = await check();
			if (v) return v;
		} catch {}
		if (Date.now() > deadline) return null;
		await sleep(every);
	}
}

const result = { hub: HUB, mode: MODE, target: TARGET, startedAt: new Date().toISOString(), logs: [], net: [] };
let child;
try {
	const BIN = await findBrowser();
	result.browser = BIN;
	await mkdir(OUT, { recursive: true });
	const profile = path.join(os.tmpdir(), `zoetrope-ckscram-${MODE}-${Date.now()}`);
	child = spawn(
		BIN,
		[
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--remote-debugging-port=" + PORT,
			"--user-data-dir=" + profile,
			"--window-size=1680,1000",
			...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
			"about:blank",
		],
		{ stdio: ["ignore", "pipe", "pipe"] }
	);
	child.stderr.on("data", (d) => {
		const s = d.toString().trim();
		if (s) result.logs.push(`[chrome] ${s.slice(0, 300)}`);
	});

	const target = await waitFor(
		async () => {
			const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
			const list = await res.json();
			return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
		},
		{ budget: 25_000, every: 300 }
	);
	if (!target) throw new Error("devtools 未就绪");
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true });
		ws.addEventListener("error", () => rej(new Error("ws 失败")), { once: true });
	});
	const cdp = new CDP(ws);
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	await cdp.send("Network.enable");

	// 只留一个酷安平台，按 MODE 决定走不走代理
	const sites = JSON.stringify([
		{ id: "coolapk", name: "酷安", url: TARGET, accent: "#7ed321", proxied: MODE === "proxied" },
	]);
	await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `try { localStorage.setItem("zoetrope.sites", ${JSON.stringify(sites)}); } catch (e) {}`,
	});

	await cdp.send("Page.navigate", { url: HUB });
	const booted = await waitFor(() => cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)"), {
		budget: BOOT_BUDGET_MS,
	});
	result.booted = !!booted;
	if (!booted) result.bootError = await cdp.evaluate("String(window.__ZOETROPE?.error)").catch(String);

	// 等酷安视图不再是 loading
	await waitFor(
		async () => {
			const p = await cdp.evaluate('JSON.stringify(window.__ZOETROPE.probe())');
			const o = JSON.parse(p);
			return o.coolapk && o.coolapk.state !== "loading" ? o : null;
		},
		{ budget: SETTLE_MS, every: 2000 }
	);
	await sleep(4000);

	result.probe = JSON.parse(await cdp.evaluate("JSON.stringify(window.__ZOETROPE.probe())"));
	result.hubCookie = await cdp.evaluate("document.cookie");

	// 代理视图是同源的，可以直接读 iframe；直连视图跨源读不到
	result.frame = await cdp.evaluate(`(() => {
		const f = document.getElementById("view-coolapk");
		if (!f) return { error: "iframe 不存在" };
		const out = { src: f.getAttribute("src") || null, mode: ${JSON.stringify(MODE)} };
		try {
			const d = f.contentDocument;
			out.readable = true;
			out.href = f.contentWindow.location.href;
			out.title = d.title;
			out.text = (d.body ? d.body.innerText : "").slice(0, 1200);
			out.cookie = d.cookie;
		} catch (e) {
			out.readable = false;
			out.error = String(e);
		}
		return out;
	})()`);

	if (MODE === "proxied" && result.frame?.readable) {
		// 直接在代理页面里打一次 /api/rpc，看服务端返回什么
		result.rpc = await cdp.evaluate(`(async () => {
			const out = {};
			const s = await fetch("/api/session", { credentials: "same-origin" });
			out.sessionStatus = s.status;
			out.sessionBody = await s.text();
			out.documentCookieAfterSession = document.cookie;
			const r = await fetch("/api/rpc", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cmd: "get_version", args: {} }),
			});
			out.rpcStatus = r.status;
			out.rpcBody = (await r.text()).slice(0, 400);
			return out;
		})()`);
		// SW 侧的 cookie 罐（IndexedDB）
		result.jar = await cdp.evaluate(`(async () => {
			try {
				const db = await new Promise((res, rej) => { const r = indexedDB.open("$scramjet"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
				if (!db.objectStoreNames.contains("cookies")) return "no cookies store";
				const rec = await new Promise((res) => { const q = db.transaction("cookies","readonly").objectStore("cookies").get("cookies"); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
				const jar = rec && rec.value ? rec.value : rec;
				return jar ? Object.keys(jar).map(k => k + " -> " + JSON.stringify(jar[k])) : "empty";
			} catch (e) { return "err " + e; }
		})()`);
	}

	result.logs = result.logs.concat(cdp.logs);
	result.net = cdp.net;
	ws.close();
} catch (e) {
	result.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
console.log(`hub=${HUB} mode=${MODE} target=${TARGET}`);
console.log(`booted=${result.booted} fatal=${result.fatal || "-"}`);
console.log("probe   :", JSON.stringify(result.probe?.coolapk || null));
console.log("frame   :", JSON.stringify(result.frame || null));
console.log("hubCookie:", JSON.stringify(result.hubCookie));
console.log("rpc     :", JSON.stringify(result.rpc || null));
console.log("jar     :", JSON.stringify(result.jar || null));
console.log("net     :");
for (const n of result.net) {
	if (n.kind === "request") {
		console.log(`  → ${n.method} ${n.url}\n      origin=${n.origin} cookie=${n.cookie}`);
	} else {
		console.log(`  ← ${n.status} ${n.url}\n      set-cookie=${n.setCookie}`);
	}
}
console.log("logs    :", result.logs.filter((l) => /coolapk|token|api\/|error/i.test(l)).slice(0, 30).join("\n           "));
console.log("out     :", path.join(OUT, "result.json"));
process.exit(result.fatal ? 1 : 0);
