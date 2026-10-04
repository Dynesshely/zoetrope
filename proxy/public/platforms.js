/**
 * 默认站点列表。
 *
 * proxied: true  → 经 Scramjet 代理加载（绕开 X-Frame-Options / CSP frame-ancestors）
 * proxied: false → 直接 iframe 加载（仅适用于自己控制的站点，例如自建酷安 Web 版）
 *
 * 这是**默认值**。用户在页面里通过「设置」改过之后，会以 localStorage 的
 * `zoetrope.sites` 为准（见文件末尾）。
 *
 * icon（可选）：控制栏最左侧那个站点图标的**真实网址**。
 *   不写的话会退回「目标站根 + /favicon.ico」，再退回平台名首字的徽标。
 *   文档就绪后，hub.js 还会尝试升级成页面 `<link rel="icon">` 里声明的那份 ——
 *   所以只有"根 favicon 不可用、文档声明又取不到"时才需要显式写。
 *   知乎就属于这种：https://www.zhihu.com/favicon.ico 是 301，不是图片。
 */
const ZOETROPE_DEFAULT_SITES = [
	{
		id: "bilibili",
		name: "哔哩哔哩",
		url: "https://www.bilibili.com/",
		accent: "#fb7299",
		proxied: true,
	},
	{
		id: "zhihu",
		name: "知乎",
		url: "https://www.zhihu.com/",
		icon: "https://static.zhihu.com/heifetz/favicon.ico",
		accent: "#0084ff",
		proxied: true,
	},
	{
		id: "douyin",
		name: "抖音",
		url: "https://www.douyin.com/",
		accent: "#25f4ee",
		proxied: true,
	},
	{
		id: "coolapk",
		name: "酷安",
		// 自建酷安 Web 版（../coolapk-desktop，Vue 3 + Axum）。
		//
		// 两个硬约束：
		//   1) 直连模式（proxied: false）—— 自己控制的站点不需要代理；
		//   2) **必须与 hub 同主机同协议**。它的会话 Cookie 是 SameSite=Strict
		//      （见 coolapk-desktop/vite.config.ts），跨站嵌入时浏览器不会带上，
		//      应用会报"缺少或无效的会话 token，请通过服务端地址访问本服务"。
		//      所以这里用 {host} 占位符，按 hub 自己的主机名拼地址。
		//      注意：写死成 10.0.30.61 会在你走 127.0.0.1 隧道时变成跨站，登录态会丢。
		//
		// 端口对应关系见 docker-compose.yml / tls/Caddyfile：
		//   :17520 = Vite dev server 明文 HTTP
		//   :17521 = Caddy 给它的 HTTPS 入口（HTTPS 页面嵌 http 会被混合内容拦掉）
		urlTemplate: "http://{host}:17520/#/",
		urlTemplateHttps: "https://{host}:17521/#/",
		accent: "#7ed321",
		proxied: false,
	},
];

/** 用户在设置弹窗里保存过的站点列表优先 */
window.PLATFORMS = (() => {
	try {
		const saved = JSON.parse(localStorage.getItem("zoetrope.sites") || "null");
		if (Array.isArray(saved) && saved.length) return saved;
	} catch {}
	return ZOETROPE_DEFAULT_SITES;
})();
