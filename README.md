# defib 🫀

System defibrillator - monitors health and auto-recovers from common failure modes.

Works with **Docker** or **Podman** (auto-detects).

## What It Monitors

| Mode | Detects | Auto-Recovery |
|------|---------|---------------|
| `container` | Unresponsive HTTP endpoints | Restarts via docker-compose |
| `processes` | High CPU, memory hogs | Kills safe-to-kill processes |
| `system` | Swap pressure, stuck processes (D-state) | Alerts only |
| `all` | Everything above | All of the above |

## Installation

```bash
# Requires Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# Clone and run
git clone https://github.com/alexknowshtml/defib.git
cd defib
```

## Quick Start

```bash
# Monitor a container
bun run defib.ts container --health http://localhost:8000/health --compose-dir ./my-app

# Monitor processes
bun run defib.ts processes

# Monitor system health
bun run defib.ts system

# Monitor everything (use config file)
bun run defib.ts all --config ./defib.config.json
```

## Commands

### `defib container`

Monitors container health via HTTP endpoint, auto-restarts if unhealthy.

```bash
bun run defib.ts container \
  --health http://localhost:8000/health \
  --compose-dir ./my-app \
  --timeout 10 \
  --max-response 15 \
  --backoff 10 \
  --service web
```

**Options:**
- `--health <url>` - Health endpoint URL (required)
- `--compose-dir <path>` - Directory with docker-compose.yml (required)
- `--timeout <sec>` - Health check timeout (default: 10)
- `--max-response <sec>` - Max acceptable response time (default: 15)
- `--backoff <min>` - Minutes between restart attempts (default: 10)
- `--service <name>` - Specific service to restart

### `defib processes`

Monitors for runaway processes (high CPU/memory), auto-kills if safe.

```bash
bun run defib.ts processes \
  --cpu-threshold 80 \
  --memory-threshold 2000 \
  --max-runtime 2 \
  --safe-to-kill "node mcp-" \
  --ignore "postgres" \
  --ignore "ollama"
```

**Options:**
- `--cpu-threshold <pct>` - CPU % to flag as runaway (default: 80)
- `--memory-threshold <mb>` - Memory MB to flag (default: 2000)
- `--max-runtime <hours>` - Hours before flagging high-CPU process (default: 2)
- `--safe-to-kill <pattern>` - Process pattern safe to auto-kill (repeatable)
- `--ignore <pattern>` - Process pattern to ignore (repeatable)

### `defib system`

Monitors system health (swap pressure, stuck processes).

```bash
bun run defib.ts system \
  --swap-threshold 80 \
  --no-dstate
```

**Options:**
- `--swap-threshold <pct>` - Swap % to alert (default: 80)
- `--no-dstate` - Disable D-state (stuck process) monitoring

### `defib all`

Runs all monitors. Best used with a config file.

```bash
bun run defib.ts all --config ./defib.config.json
```

## Configuration

### Config File

```json
{
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "stateFile": "/tmp/defib-state.json",
  "container": {
    "healthUrl": "http://localhost:8000/health",
    "composeDir": "/path/to/app",
    "timeoutSeconds": 10,
    "maxResponseSeconds": 15,
    "backoffMinutes": 10,
    "serviceName": "web"
  },
  "processes": {
    "cpuThreshold": 80,
    "memoryThresholdMB": 2000,
    "maxRuntimeHours": 2,
    "safeToKillPatterns": ["mcp-", "node.*watchdog"],
    "ignorePatterns": ["postgres", "ollama", "code-server"]
  },
  "system": {
    "swapThreshold": 80,
    "checkDState": true
  }
}
```

### Environment Variables

```bash
export DEFIB_WEBHOOK_URL=https://discord.com/api/webhooks/...
export DEFIB_HEALTH_URL=http://localhost:8000/health
export DEFIB_COMPOSE_DIR=/path/to/app
```

## Running on a Schedule

### With cron

```bash
# Check containers every 2 minutes
*/2 * * * * /path/to/bun /path/to/defib.ts container --health http://localhost:8000/health --compose-dir /app

# Check processes every 15 minutes
*/15 * * * * /path/to/bun /path/to/defib.ts processes

# Full health check every 5 minutes
*/5 * * * * /path/to/bun /path/to/defib.ts all --config /etc/defib/config.json
```

### With PM2

```bash
pm2 start defib.ts --name defib-container --cron "*/2 * * * *" --no-autorestart -- container --health http://localhost:8000/health --compose-dir /app
pm2 start defib.ts --name defib-processes --cron "*/15 * * * *" --no-autorestart -- processes
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

### Container Monitoring
1. HTTP GET to health endpoint
2. If unhealthy → `docker-compose down && docker-compose up -d`
3. Verify health after restart
4. Enter backoff period to prevent thrashing

### Process Monitoring
1. Parse `ps` output for CPU, memory, runtime
2. Flag processes exceeding thresholds
3. Auto-kill if matches `safe-to-kill` pattern
4. Track known issues to avoid duplicate alerts

### System Monitoring
1. Check swap usage via `free -m`
2. Check for D-state processes via `ps`
3. Skip kernel threads and short D-states
4. Alert on resolution when issues clear

## Notifications

Supports Discord and Slack webhooks. Notifications include:

- **Container Restarted** - Service was down, now recovered
- **Container Restart FAILED** - Manual intervention needed
- **Runaway Process Killed** - Auto-killed a safe process
- **Runaway Process Detected** - High CPU, needs attention
- **High Memory Process** - Memory hog detected
- **Swap Pressure Critical** - System may become unresponsive
- **Stuck Process Detected** - Process in D-state

## State Persistence

defib maintains state in `/tmp/defib-state.json` (configurable):

- Tracks restart backoff timers
- Remembers known issues to avoid duplicate alerts
- Cleans up resolved issues automatically

## License

MIT
