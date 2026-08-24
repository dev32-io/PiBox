# PiBox service adapter

The service adapter coordinates local services without tying their lifetime to Pi's Node process. It provides the `service_adapter` tool and `/services [status|start|stop|update] [service]` command.

Built-in service descriptors:

| Service | `internal` | `stayAlive` | `singleton` | `perSession` |
|---|---:|---:|---:|---:|
| Mem0 | true | true | true | false |
| SearXNG | true | true | true | false |
| Visual companion | true | false | true | true |

`singleton` operations use a user-scoped filesystem lock and recheck health after acquiring it. Shared services survive session shutdown. Updates are separate from startup and require interactive approval. Compose commands use argument arrays, bounded output, cancellation, and readiness probes.

Defaults:

- Mem0 Compose: bundled `services/mem0/compose.yaml`; override with `PIBOX_MEM0_SERVICE_DIR`.
- Mem0 endpoint: `http://127.0.0.1:6001`; override with `PIBOX_MEM0_URL`.
- SearXNG Compose: bundled `services/searxng/compose.yaml`; override with `PIBOX_SEARXNG_SERVICE_DIR`.
- SearXNG endpoint: `http://127.0.0.1:6000/`; override with `PIBOX_SEARXNG_URL`.

Durable service data uses bind mounts beneath `~/.pi/pibox/services/<service>/`; PiBox does not use opaque named volumes. The footer renders every registered service in one compact ordered row. Healthy services use green `●`, intentionally stopped services use dim `○`, transitions use warning `◌`, and failures use red `!`. Each service also registers with the shared interactive footer, whose overlay exposes health details, refresh, and start/stop actions; image updates remain outside that surface and retain their explicit approval gate.
