#!/usr/bin/env bash
#
# 生成一套本地自签证书：
#   ca.crt / ca.key       —— 本地根 CA（10 年），装到设备上就永久免警告
#   server.crt/server.key —— 服务器证书（397 天），SAN 覆盖 LAN IP 与 localhost
#
# 为什么要分成根 CA + 叶子，而不是直接自签一张叶子：
#   叶子直接自签时，浏览器只能"点过警告"，而这个状态下 Service Worker 能否注册
#   并不确定。装一张根 CA 是一劳永逸的确定解。
#
# 用法：
#   ./gen-certs.sh              # 不存在才生成
#   FORCE=1 ./gen-certs.sh      # 强制重新生成
#   HOST_IP=10.0.30.61 EXTRA_DNS="dev-u26-001 foo.lan" ./gen-certs.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS="$DIR/certs"
HOST_IP="${HOST_IP:-10.0.30.61}"
EXTRA_DNS="${EXTRA_DNS:-$(hostname)}"
LEAF_DAYS="${LEAF_DAYS:-397}"
CA_DAYS="${CA_DAYS:-3650}"

mkdir -p "$CERTS"
cd "$CERTS"

if [ -f ca.crt ] && [ -f server.crt ] && [ "${FORCE:-0}" != "1" ]; then
	echo "证书已存在（FORCE=1 可强制重新生成）："
	openssl x509 -in ca.crt -noout -subject -enddate | sed 's/^/  CA   /'
	openssl x509 -in server.crt -noout -subject -enddate | sed 's/^/  leaf /'
	openssl x509 -in server.crt -noout -ext subjectAltName | tail -n +2 | sed 's/^/       /'
	exit 0
fi

# 拼 SAN：LAN IP + 回环 + 主机名
SAN="IP:${HOST_IP},IP:127.0.0.1,DNS:localhost"
for d in $EXTRA_DNS; do
	[ "$d" = "localhost" ] && continue
	SAN="$SAN,DNS:$d"
done

echo "==> 生成根 CA（$CA_DAYS 天）"
openssl genrsa -out ca.key 4096 2>/dev/null
openssl req -x509 -new -nodes -key ca.key -sha256 -days "$CA_DAYS" \
	-subj "/O=zoetrope/CN=zoetrope Local CA" \
	-addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
	-addext "keyUsage=critical,keyCertSign,cRLSign" \
	-out ca.crt

echo "==> 生成服务器证书（$LEAF_DAYS 天），SAN: $SAN"
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -subj "/O=zoetrope/CN=${HOST_IP}" -out server.csr

cat >server.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${SAN}
EOF

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
	-out server.crt -days "$LEAF_DAYS" -sha256 -extfile server.ext 2>/dev/null

rm -f server.csr server.ext
chmod 600 ca.key server.key
chmod 644 ca.crt server.crt

# 供未安装 CA 的设备下载（Caddy 以 /ca.crt 提供）
cp -f ca.crt "$DIR/site/ca.crt" 2>/dev/null || true

echo
echo "完成。自检："
openssl verify -CAfile ca.crt server.crt | sed 's/^/  /'
openssl x509 -in server.crt -noout -ext subjectAltName | tail -n +2 | sed 's/^/  /'
