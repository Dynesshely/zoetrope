#!/usr/bin/env node
/**
 * 非代理（跨源直连）视图的地址栏回归。
 *
 * 曾经显示 about:blank：iframe 刚 append、还没导航时，contentDocument 是
 * **同源**的 about:blank，被 realUrlOf 当成真实网址塞进了历史栈。
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HUB = process.env.HUB_URL || "http://localhost:18095/";
const PORT = Number(process.env.CDP_PORT || 19930);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "coolapk-addr");
const BIN = process.env.CHROME_BIN || "/home/dynesshely/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const child = spawn(BIN, ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--remote-debugging-port=${PORT}`,
	`--user-data-dir=${path.join(os.tmpdir(), "zoetrope-ck-" + Date.now())}`, "--window-size=1680,1000",
	...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean) : []), HUB], { stdio: ["ignore", "ignore", "ignore"] });

let target = null;
for (let i = 0; i < 80 && !target; i++) {
	try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page" && x.webSocketDebuggerUrl); } catch {}
	if (!target) await sleep(300);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0; const pend = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pend.delete(id)) rej(new Error("t/o")); }, 20000); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? "EXC " + r.exceptionDetails.text : r.result.value; };
await send("Runtime.enable");
for (let i = 0; i < 90; i++) { if (await ev("!!(window.__ZOETROPE&&window.__ZOETROPE.ready)")) break; await sleep(500); }
await sleep(22000);

const r = await ev(`JSON.stringify((() => {
	const out = {};
	for (const p of document.querySelectorAll(".pane")) {
		const f = p.querySelector("iframe");
		out[p.dataset.id] = { srcAttr: f.getAttribute("src"), addr: p.querySelector(".addr").value };
	}
	return out;
})())`);
console.log(r);
await writeFile(path.join(OUT, "result.json"), r);
child.kill("SIGKILL");
process.exit(0);
