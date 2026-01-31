# defib 🫀

Container defibrillator - monitors health endpoints and auto-restarts unresponsive containers.

Works with **Docker** or **Podman** (auto-detects which is available).

## Features

- **Health monitoring** - HTTP endpoint checks with configurable timeout
- **Auto-restart** - Brings containers back to life via docker-compose/podman-compose
- **Anti-thrash** - Backoff period prevents restart loops
- **Notifications** - Discord/Slack webhook support
- **State persistence** - Tracks restart history across runs

## Installation

```bash
# Requires Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# Clone and run
git clone https://github.com/alexknowshtml/defib.git
cd defib
bun install
```

## Usage

### CLI

```bash
# Basic usage
bun run defib.ts --health http://localhost:8000/health --compose-dir ./my-app

# With notifications
bun run defib.ts \
  --health http://localhost:8000/health \
  --compose-dir ./my-app \
  --webhook https://discord.com/api/webhooks/...

# All options
bun run defib.ts \
  --health http://localhost:8000/health \
  --compose-dir ./my-app \
  --webhook https://discord.com/api/webhooks/... \
  --timeout 10 \
  --max-response 15 \
  --backoff 10 \
  --service my-service
```

### Config File

```bash
bun run defib.ts --config ./defib.config.json
```

```json
{
  "healthUrl": "http://localhost:8000/health",
  "composeDir": "/path/to/app",
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "timeoutSeconds": 10,
  "maxResponseSeconds": 15,
  "backoffMinutes": 10,
  "serviceName": "web"
}
```

### Environment Variables

```bash
export DEFIB_HEALTH_URL=http://localhost:8000/health
export DEFIB_COMPOSE_DIR=/path/to/app
export DEFIB_WEBHOOK_URL=https://discord.com/api/webhooks/...
export DEFIB_TIMEOUT=10
export DEFIB_MAX_RESPONSE=15
export DEFIB_BACKOFF=10

bun run defib.ts
```

## Running on a Schedule

### With cron

```bash
# Check every 2 minutes
*/2 * * * * /path/to/bun /path/to/defib.ts --config /path/to/config.json
```

### With PM2

```bash
pm2 start defib.ts --name defib --cron "*/2 * * * *" --no-autorestart
```

### With systemd timer

```ini
# /etc/systemd/system/defib.timer
[Unit]
Description=Run defib health check

[Timer]
OnCalendar=*:0/2
Persistent=true

[Install]
WantedBy=timers.target
```

## How It Works

1. **Check health** - HTTP GET to your health endpoint
2. **Evaluate** - Healthy if 2xx response within timeout
3. **Restart if unhealthy** - `docker-compose down && docker-compose up -d`
4. **Verify** - Re-check health after restart
5. **Notify** - Send webhook on restart (success or failure)
6. **Backoff** - Wait N minutes before allowing another restart

### Anti-Thrash Protection

If your container keeps crashing, defib won't hammer it with restarts. After each restart attempt, it enters a backoff period (default: 10 minutes) before trying again.

State is persisted to `/tmp/defib-*.json` so backoff survives process restarts.

## Options

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--health` | `DEFIB_HEALTH_URL` | required | Health endpoint URL |
| `--compose-dir` | `DEFIB_COMPOSE_DIR` | required | docker-compose.yml location |
| `--webhook` | `DEFIB_WEBHOOK_URL` | - | Notification webhook URL |
| `--timeout` | `DEFIB_TIMEOUT` | 10 | Health check timeout (seconds) |
| `--max-response` | `DEFIB_MAX_RESPONSE` | 15 | Max acceptable response time |
| `--backoff` | `DEFIB_BACKOFF` | 10 | Minutes between restart attempts |
| `--service` | - | - | Specific service to restart |
| `--config` | - | - | Path to config JSON file |

## License

MIT
