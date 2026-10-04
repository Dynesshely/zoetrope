#!/usr/bin/env node
/**
 * Cookie 持久化探针。
 *
 * Scramjet 把 cookie 罐存在 IndexedDB（库 $scramjet、store cookies），
 * 但源码里 put 只出现在「收到客户端 postMessage 的 cookie」分支。
 * 本脚本检查：服务器用 Set-Cookie 头下发的 cookie 到底有没有落盘。
 *
 * 用法：HUB_URL=http://127.0.0.1:18095/ node verify/cookie-check.mjs
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const VIEW = process.env.VIEW || "zhihu";
const PORT = Number(process.env.CDP_PORT || 19670);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "cookie");

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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 IndexedDB 里的 $scramjet / cookies */
const READ_IDB = `(async () => {
	const list = await indexedDB.databases().catch(() => []);
	const names = list.map(d => d.name + "@" + d.version);
	if (!list.some(d => d.name === "$scramjet")) return { dbs: names, exists: false };
	const db = await new Promise((res, rej) => {
		const r = indexedDB.open("$scramjet");
		r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
	});
	const stores = [...db.objectStoreNames];
	if (!stores.includes("cookies")) return { dbs: names, exists: true, stores };
	const out = await new Promise((res) => {
		const tx = db.transaction("cookies", "readonly");
		const q = tx.objectStore("cookies").getAll();
		q.onsuccess = () => res({ keys: q.result.map(r => r.id || r.key), raw: q.result });
		q.onerror = () => res({ error: String(q.error) });
	});
	return { dbs: names, exists: true, stores, count: out.raw ? out.raw.length : 0, sample: JSON.stringify(out.raw).slice(0, 600) };
})()`;

const READ_FRAME_COOKIE = `(() => {
	const f = document.getElementById("view-${VIEW}");
	try { return (f && f.contentDocument ? f.contentDocument.cookie : "") || "(空)"; }
	catch (e) { return "跨源读不到: " + e.name; }
})()`;

await mkdir(OUT, { recursive: true });
const out = { hub: HUB, view: VIEW };
let child;
try {
	const BIN = await findBrowser();
	const profile = path.join(os.tmpdir(), `zoetrope-cookie-${Date.now()}`);
	child = spawn(BIN, [
		"--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
		"--window-size=1280,900",
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
	// 等目标站点自己写下 cookie（zhihu 首访会下发 _zap / _xsrf / BEC）
	await sleep(12000);

	out.frameCookie = await cdp.evaluate(READ_FRAME_COOKIE);
	out.idb = await cdp.evaluate(READ_IDB);

	// 让页面自己写一个 document.cookie（走 postMessage 分支），对比是否落盘
	await cdp.evaluate(`(() => {
		const f = document.getElementById("view-${VIEW}");
		f.contentDocument.cookie = "zoetrope_probe=1; path=/";
		return f.contentDocument.cookie;
	})()`);
	await sleep(2500);
	out.afterPageWrite = await cdp.evaluate(READ_FRAME_COOKIE);
	out.idbAfterWrite = await cdp.evaluate(READ_IDB);

	// ── 第二阶段：杀掉全部 Service Worker（模拟浏览器回收 / 重启），再刷新 ──────
	await cdp.send("ServiceWorker.enable").catch(() => {});
	await cdp.send("ServiceWorker.stopAllWorkers").catch((e) => (out.stopErr = String(e)));
	await sleep(1500);
	out.swAfterKill = await cdp.evaluate(
		`navigator.serviceWorker.getRegistrations().then(r => r.length)`
	);

	await cdp.send("Page.reload", { ignoreCache: false });
	await sleep(3000);
	for (let i = 0; i < 60; i++) {
		if (await cdp.evaluate("!!(window.__ZOETROPE && window.__ZOETROPE.ready)")) break;
		await sleep(1000);
	}
	await sleep(10000);
	out.afterSwRestart = await cdp.evaluate(READ_FRAME_COOKIE);
	out.idbAfterRestart = await cdp.evaluate(READ_IDB);
	out.probeSurvived = String(out.afterSwRestart).includes("zoetrope_probe=1");

	ws.close();
} catch (e) {
	out.fatal = String(e?.stack || e);
} finally {
	if (child) try { child.kill("SIGKILL"); } catch {}
}

await writeFile(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
console.log("① 代理页面里的 cookie      :", String(out.frameCookie).slice(0, 200));
console.log("② IndexedDB 状态           :", JSON.stringify(out.idb));
console.log("③ 页面写一个 cookie 后      :", String(out.afterPageWrite).slice(0, 200));
console.log("④ 之后 IndexedDB           :", JSON.stringify(out.idbAfterWrite));
console.log("⑤ 杀掉 SW 后注册数         :", out.swAfterKill, out.stopErr ? "| stopErr=" + out.stopErr : "");
console.log("⑥ SW 重启 + 刷新后的 cookie :", String(out.afterSwRestart).slice(0, 200));
console.log("⑦ 探针 cookie 是否存活      :", out.probeSurvived);
console.log("fatal:", out.fatal || "-");
process.exit(0);
