/**
 * zoetrope — 拦截代理服务端
 *
 * 基于 Mercury Workshop 的 Scramjet（AGPL-3.0）参考实现 Scramjet-App 改写：
 *   - 静态根从上游的 public/ 换成我们自己的多视图 hub
 *   - 增加 IPv4 优先解析与国内 DNS，规避容器无 IPv6 路由 / Cloudflare DNS 不可达
 *   - 增加 /healthz 便于探活
 *
 * 服务端职责：
 *   /            → 多视图 hub 页面
 *   /scram/      → Scramjet 客户端产物（bundle / wasm / sync）
 *   /libcurl/    → libcurl-transport 产物
 *   /baremux/    → bare-mux 产物
 *   /wisp/       → Wisp over WebSocket，客户端经此建立到目标站点的裸 TCP
 */

import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import dns from "node:dns";

import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

// 容器内没有 IPv6 路由，而 DNS 默认返回 AAAA 优先 → 全部连接失败。
// 强制 IPv4 优先是本机能否直连的决定性一行。
dns.setDefaultResultOrder(process.env.DNS_RESULT_ORDER || "ipv4first");

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Wisp：真正的出网点。它走裸 TCP，**不经过 HTTP_PROXY**。
//
// DNS 这里踩过两个坑，所以不用 wisp 内置的 resolve 模式，改用自定义解析函数：
//
//   坑 1：默认 dns_result_order="verbatim"，其分支是 resolve6 → resolve4（先 AAAA）。
//         本机没有 IPv6 路由，wisp 又是裸 TCP、不做 happy-eyeballs，
//         一旦目标有 AAAA 记录就必然连接失败。
//   坑 2：即使设成 ipv4first，内置模式仍走 resolve4 → resolve6 的**回退链**：
//         外网 DNS（223.5.5.5）的 UDP 查询一旦超时，就会回退到 AAAA，
//         于是坑 1 又回来了 —— 表现为代理**间歇性 500**，极难排查。
//
// 自定义函数用系统解析器（本机 10.0.30.51，与宿主 curl 走同一条路），
// 只取 IPv4，任何情况下都不返回 AAAA，并做一层缓存。
const dns4Cache = new Map();
const DNS4_TTL = 60_000;

async function lookupIPv4(hostname) {
	const hit = dns4Cache.get(hostname);
	if (hit && Date.now() - hit.at < DNS4_TTL) return hit.addr;

	const list = await new Promise((resolve) => {
		dns.lookup(hostname, { all: true, order: "ipv4first" }, (err, addrs) =>
			resolve(err ? [] : addrs)
		);
	});
	const v4 = list.filter((a) => a.family === 4).map((a) => a.address);
	// 纯 IPv6 的目标这里会拿不到地址；本网络没有 IPv6 路由，拿到也没用，
	// 所以宁可报错让上层看到，也不要回退到一个永远连不通的地址。
	if (!v4.length) throw new Error(`no IPv4 address for ${hostname}`);

	dns4Cache.set(hostname, { addr: v4[0], at: Date.now() });
	return v4[0];
}

// WISP_DEBUG=1 打开 Wisp 的详细日志（排查出网故障时用）
logging.set_level(process.env.WISP_DEBUG ? logging.DEBUG : logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [],
	dns_method: lookupIPv4,
});

const fastify = Fastify({
	serverFactory: (handler) =>
		createServer()
			.on("request", (req, res) => {
				// 跨源隔离头，可用 COEP 环境变量调整：
				//   credentialless（默认）—— 允许无 CORP 的跨源 iframe（自建酷安 Web 版）
				//   require-corp            —— 更严格，但会拦掉没有 CORP 头的跨源 iframe
				//   off                     —— 完全不发，用于排查嵌入问题
				const coep = process.env.COEP || "off";
				if (coep !== "off") {
					res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
					res.setHeader("Cross-Origin-Embedder-Policy", coep);
				}
				if (req.url === "/healthz") {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true, pid: process.pid, coep }));
					return;
				}
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
			}),
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.register(fastifyStatic, {
	root: scramjetPath,
	prefix: "/scram/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: libcurlPath,
	prefix: "/libcurl/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
});

fastify.setNotFoundHandler((req, reply) =>
	reply.code(404).type("text/plain").send("not found")
);

fastify.server.on("listening", () => {
	const address = fastify.server.address();
	console.log(`[smv] listening on http://${hostname()}:${address.port}`);
	console.log(`[smv] wisp dns = 自定义解析函数（系统解析器，仅 IPv4，带 ${DNS4_TTL / 1000}s 缓存）`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() {
	console.log("[smv] shutting down");
	fastify.close();
	process.exit(0);
}

let port = parseInt(process.env.PORT || "", 10);
if (Number.isNaN(port)) port = 8080;

fastify.listen({ port, host: "0.0.0.0" });
