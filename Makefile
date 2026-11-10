.DEFAULT_GOAL := help

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
COMPOSE := docker compose --env-file "$(ROOT)/docker/.env" -f "$(ROOT)/docker/docker-compose.quickstart.yml" -f "$(ROOT)/docker/docker-compose.public.yml"
SERVICES := paperclip-db paperclip tuna-proxy

.PHONY: help docker-check docker-up docker-build docker-apply-env docker-restart docker-stop docker-logs docker-status docker-bootstrap

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "; print "Paperclip Docker environment (existing Tuna tunnel managed separately):"} /^[a-zA-Z_-]+:.*## / {printf "  %-22s %s\n", $$1, $$2}' "$(ROOT)/Makefile"

docker-check: ## Validate Compose without printing resolved secrets
	@$(COMPOSE) config --quiet

docker-up: docker-check ## Start the existing environment without building images
	@$(COMPOSE) up -d --no-build $(SERVICES)
	@$(COMPOSE) restart tuna-proxy

docker-build: docker-check ## Build the production image from the current checkout; do not deploy
	@$(COMPOSE) build --build-arg PAPERCLIP_BUILD_COMMIT="$$(git -C "$(ROOT)" rev-parse HEAD)" paperclip

docker-apply-env: docker-check ## Recreate Paperclip to apply .env, then refresh the proxy upstream
	@$(COMPOSE) up -d --no-build --no-deps --force-recreate paperclip
	@$(COMPOSE) restart tuna-proxy

docker-restart: docker-check ## Restart Paperclip and proxy; does not apply changed .env
	@$(COMPOSE) restart paperclip
	@$(COMPOSE) restart tuna-proxy

docker-stop: docker-check ## Stop this environment without deleting containers, volumes or the Tuna tunnel
	@$(COMPOSE) stop tuna-proxy paperclip paperclip-db

docker-logs: ## Follow Paperclip and proxy logs (Ctrl+C stops following only)
	@$(COMPOSE) logs --follow --tail 100 paperclip tuna-proxy

docker-status: ## Show this environment's containers
	@$(COMPOSE) ps --all $(SERVICES)

docker-bootstrap: docker-check ## Print a sensitive one-time first-admin link using the prepared CLI config
	@$(COMPOSE) exec -T --user node paperclip sh -c 'test -r /paperclip/bootstrap-cli-config.json || { echo "Missing /paperclip/bootstrap-cli-config.json; prepare the CLI config first." >&2; exit 1; }; node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts auth bootstrap-ceo --config /paperclip/bootstrap-cli-config.json --base-url "$$PAPERCLIP_PUBLIC_URL"'
