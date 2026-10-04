"use strict";

/**
 * 注册 Scramjet 的 Service Worker。
 *
 * Service Worker 只在安全上下文可用：
 *   - https://任何主机
 *   - http://localhost / http://127.0.0.1
 * 局域网 http://10.x.x.x 不算安全上下文 —— 真实部署必须挂 HTTPS（见 DESIGN.md §14.5）。
 */
const swAllowedHostnames = ["localhost", "127.0.0.1"];

async function registerSW() {
	if (!navigator.serviceWorker) {
		if (
			location.protocol !== "https:" &&
			!swAllowedHostnames.includes(location.hostname)
		) {
			throw new Error(
				`Service Worker 需要 HTTPS（当前 ${location.protocol}//${location.host} 不是安全上下文）`
			);
		}
		throw new Error("该浏览器不支持 Service Worker");
	}

	const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
	await navigator.serviceWorker.ready;
	return reg;
}
