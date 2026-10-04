import dns from "node:dns";
import net from "node:net";

const host = process.argv[2] || "www.bilibili.com";

function tcp(ip, port = 443, ms = 2500) {
	return new Promise((res) => {
		const s = net.connect({ host: ip, port });
		const t = setTimeout(() => { s.destroy(); res(false); }, ms);
		s.on("connect", () => { clearTimeout(t); s.destroy(); res(true); });
		s.on("error", () => { clearTimeout(t); res(false); });
	});
}

const resolver = new dns.promises.Resolver();
resolver.setServers(["223.5.5.5", "119.29.29.29"]);

const viaPublic = await resolver.resolve4(host).catch((e) => ["<err:" + e.code + ">"]);
const v6 = await resolver.resolve6(host).catch(() => []);

const sysAll = await new Promise((r) =>
	dns.lookup(host, { all: true, order: "ipv4first" }, (e, a) => r(e ? [] : a))
);

console.log("host:", host);
console.log("223.5.5.5 A   :", viaPublic.join(", "));
console.log("223.5.5.5 AAAA:", v6.length ? v6.join(", ") : "(none)");
console.log("system lookup :", sysAll.map((a) => `${a.address}(v${a.family})`).join(", "));
console.log();

for (const [label, list] of [
	["public-A", viaPublic],
	["system  ", sysAll.map((a) => a.address)],
]) {
	const parts = [];
	for (const ip of [...new Set(list)].slice(0, 8)) {
		if (String(ip).startsWith("<")) continue;
		parts.push(`${ip} ${(await tcp(ip)) ? "✓" : "✗"}`);
	}
	console.log(label.padEnd(10), parts.join("  "));
}
