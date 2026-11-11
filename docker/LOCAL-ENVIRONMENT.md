# Local public Docker environment

Run `make help` from the repository root. If your terminal is in `docker/`, use
`make -C .. <target>`, for example `make -C .. docker-status`.

These commands use `docker/.env`, `docker-compose.quickstart.yml`, and the local
`docker-compose.public.yml` override. The existing Tuna tunnel and external
`docker_tuna` network are managed separately. No target removes orphan containers
or volumes. Do not run these lifecycle commands while agents are working.

## Common commands

- `make docker-up`: start PostgreSQL, Paperclip, and the proxy from existing images.
- `make docker-build`: build the production image from the current Git revision;
  the running container is not replaced.
- `make docker-apply-env`: recreate Paperclip from the current image and environment,
  then restart the proxy so it resolves the new container address. This also deploys
  an image built since the previous container was created.
- `make docker-restart`: restart Paperclip and proxy without recreating containers;
  changed `.env` values are **not** applied.
- `make docker-stop`: stop the three managed services, preserving their data and
  the separately managed Tuna tunnel. The public URL is unavailable until startup.
- `make docker-status`: show the three services, including stopped containers.
- `make docker-logs`: follow recent Paperclip and proxy logs.
- `make docker-check`: validate Compose without displaying resolved credentials.
- `make docker-bootstrap`: generate the first-admin invite using the existing
  `/paperclip/bootstrap-cli-config.json`. Treat the printed URL as a credential.
  This target requires that prepared config; it does not onboard a fresh server.

## Apply a LiteLLM key

Store `LITELLM_API_KEY` in the ignored `docker/.env`. The public Compose override
explicitly forwards this variable to Paperclip. Keep only the reference
`"apiKey": "{env:LITELLM_API_KEY}"` in the OpenCode configuration.

Run `make docker-apply-env` to apply a changed key. No image rebuild is needed.
This makes the key available in the container environment; propagation into
isolated Runner environments is a separate concern. Never commit `.env` or keys.

## Outbound MCP/OAuth proxy

The guarded MCP/OAuth HTTP transport reads operator-owned `HTTP_PROXY` and
`HTTPS_PROXY` (lowercase variants take precedence), with `NO_PROXY` / `no_proxy`
host, domain-suffix and optional port exclusions. `*` bypasses all proxies.
HTTP and HTTPS proxies are supported; SOCKS and `ALL_PROXY` are not.

The destination is resolved and checked before opening a proxy tunnel. CONNECT
uses the approved destination IP, not its hostname; the proxy must permit
IP-address CONNECT requests. HTTPS retains hostname/SNI certificate validation.
Proxy authentication is sent only to the proxy. If the proxy fails, the transport
does not silently fall back to direct egress. The configured proxy is an
operator-trusted egress boundary and can itself reside on a private network.

## Data and release safety

The current override uses database `paperclip_release_20261106` and mounts
`data/docker-paperclip-release-20261106` as `/paperclip`. PostgreSQL files live in
the named volume `paperclip-public-pgdata`. Previous data remains separate.

The Makefile does not create this database, migrate older deployments backwards,
or restore backups. Before deploying an older checkout, check database schema
compatibility and take a backup. Rebuilding or retagging an image does not itself
change the running application; `docker-up` or `docker-apply-env` may deploy it.
