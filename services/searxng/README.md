# PiBox-managed SearXNG

SearXNG remains available to pi-web-access at `http://127.0.0.1:6000`. The image is digest-pinned and all durable files are bind-mounted under:

```text
~/.pi/pibox/services/searxng/config
~/.pi/pibox/services/searxng/cache
```

Before first start, the service adapter creates `config/settings.yml` from the bundled template with a random local secret. Existing installations can copy their reviewed settings into that path before switching Compose projects.

```bash
docker compose up -d
docker compose stop
```

Service updates are explicit and approval-gated through `/services update searxng`.
