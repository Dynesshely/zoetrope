# zoetrope
#
# 构建必须带 DOCKER_CONFIG —— 那里有 registry 认证，以及 BuildKit 会自动注入
# 构建容器的 HTTP 代理（本机容器出网必须走它）。

SHELL       := /bin/bash
DOCKER_CONFIG ?= /home/dynesshely/dsh-workspaces/tools/.docker-config
export DOCKER_CONFIG

HOST_IP     ?= 10.0.30.61
HUB_PORT    ?= 18095
BOOT_PORT   ?= 18096
HTTPS_URL   ?= https://$(HOST_IP)/
HTTPS_PORT  ?= 443
FONTS_CONF  ?= /home/dynesshely/dsh-workspaces/tools/.fonts/fonts.conf

.PHONY: all build up down restart logs certs url verify verify-https probe shell clean

all: up

build:
	docker compose build

# up 依赖证书存在
up: certs
	docker compose up -d
	@echo
	@echo "  LAN    → $(HTTPS_URL)      （需先装根证书，见 $(HTTPS_URL:%/=%)$(BOOT_PORT) 的引导页）"
	@echo "  引导页 → http://$(HOST_IP):$(BOOT_PORT)/"
	@echo "  本机   → http://127.0.0.1:$(HUB_PORT)/"

down:
	docker compose down

restart: down up

logs:
	docker compose logs -f

certs:
	@HOST_IP=$(HOST_IP) ./tls/gen-certs.sh

renew-certs:
	@FORCE=1 HOST_IP=$(HOST_IP) ./tls/gen-certs.sh

url:
	@echo "$(HTTPS_URL)"

# 无头验证（HTTP，本机回环）
verify:
	@rm -rf verify/out
	@FONTCONFIG_FILE=$(FONTS_CONF) HUB_URL=http://127.0.0.1:$(HUB_PORT)/ \
		node verify/cdp-check.mjs

# 无头验证（HTTPS，LAN —— 证书自签，用 --ignore-certificate-errors 通过）
verify-https:
	@rm -rf verify/out-https
	@FONTCONFIG_FILE=$(FONTS_CONF) CHROME_ARGS="--ignore-certificate-errors" \
		HUB_URL=$(HTTPS_URL) OUT_DIR=$(CURDIR)/verify/out-https CDP_PORT=19223 \
		node verify/cdp-check.mjs

# 证书链自检
check-cert:
	@openssl s_client -connect $(HOST_IP):$(HTTPS_PORT) -servername $(HOST_IP) \
		-CAfile tls/certs/ca.crt -verify_return_error </dev/null 2>&1 \
		| grep -E 'Verify return code|subject=|issuer='

probe:
	@curl -sS http://127.0.0.1:$(HUB_PORT)/healthz; echo

shell:
	docker exec -it zoetrope-hub sh

clean:
	docker compose down --rmi local -v
	rm -rf verify/out* .build-logs
