/**
 * Scramjet Service Worker —— 全部代理请求的拦截点。
 *
 * 相比上游 Scramjet-App 的 sw.js，这里多了一件事：**先把 cookie 罐读出来再处理请求**。
 *
 * 原因：Scramjet 的 ScramjetServiceWorker 在构造函数里用一个**游离的** async IIFE
 * 去读 IndexedDB：
 *
 *     constructor(){ super(), this.client=..., (async()=>{
 *         let e = await P2("$scramjet",1), t = await e.get("cookies","cookies");
 *         t && this.cookieStore.load(t)
 *       })(), addEventListener("message", ...) }
 *
 * 没有任何人 await 它。于是 SW 冷启动（浏览器随时会回收空闲 SW）之后的第一批请求
 * 可能在罐子还没装载完时就发出去了 —— 服务器收不到凭据，当成全新会话重新下发整套
 * cookie。表现就是两个很难查的症状：
 *
 *   1. 登录态在"重启"后丢失（其实每次 SW 被回收都会发生，只是重启时最明显）
 *   2. 登录后重定向死循环：带不上凭据 → 服务器跳回登录页 → 再跳
 *      → 浏览器报 ERR_TOO_MANY_REDIRECTS
 *
 * 实测证据（verify/cookie-check.mjs）：杀掉 SW 再刷新后，zhihu 的 _zap/_xsrf/BEC
 * 三个值全部变化，手动写入的探针 cookie 消失。
 *
 * 修法：在 SW 内部自己读一次 IndexedDB，把罐子灌进同一个 cookieStore，
 * 并让 fetch 处理器先 await 这个 Promise。sw.js 是我们自己的文件，不必改上游。
 */

importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

const DB_NAME = "$scramjet";
const STORE = "cookies";
const KEY = "cookies";

/** 把 jar 里的一条记录还原成 Set-Cookie 字符串 */
function toSetCookieString(c) {
	if (!c || typeof c.name !== "string" || typeof c.value !== "string") return null;
	let s = `${c.name}=${c.value}`;
	if (c.domain) s += `; Domain=${c.domain}`;
	s += `; Path=${c.path || "/"}`;
	if (c.maxAge) s += `; Max-Age=${c.maxAge}`;
	if (c.expires) {
		const d = new Date(c.expires);
		if (!Number.isNaN(d.getTime())) s += `; Expires=${d.toUTCString()}`;
	}
	if (c.sameSite) s += `; SameSite=${c.sameSite}`;
	if (c.secure) s += "; Secure";
	if (c.httpOnly) s += "; HttpOnly";
	return s;
}

/**
 * 把持久化的 cookie 罐灌进 cookieStore。
 * cookieStore 是**每个 SW 实例一份**的内存 jar，SW 被回收即清零，
 * 所以每次 SW 启动都必须重放一次。
 */
const jarReady = (async () => {
	try {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		if (!db.objectStoreNames.contains(STORE)) return 0;

		const rec = await new Promise((resolve) => {
			const q = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
			q.onsuccess = () => resolve(q.result);
			q.onerror = () => resolve(null);
		});
		const jar = rec && rec.value ? rec.value : rec;
		if (!jar || typeof jar !== "object") return 0;

		let n = 0;
		for (const k of Object.keys(jar)) {
			const c = jar[k];
			const str = toSetCookieString(c);
			if (!str) continue;
			const host = String(c.domain || "").replace(/^\./, "");
			if (!host) continue;
			scramjet.cookieStore.setCookies([str], new URL("https://" + host + "/"));
			n++;
		}
		return n;
	} catch (e) {
		console.warn("[zoetrope/sw] cookie 罐重放失败", e);
		return 0;
	}
})();

jarReady.then((n) => console.log(`[zoetrope/sw] 已重放 ${n} 条持久化 cookie`));

self.addEventListener("fetch", (event) => {
	event.respondWith(
		(async () => {
			// ⚠️ 关键：等 cookie 罐装载完再处理请求，否则第一批请求不带凭据
			await jarReady;
			await scramjet.loadConfig();
			if (scramjet.route(event)) return scramjet.fetch(event);
			return fetch(event.request);
		})()
	);
});
