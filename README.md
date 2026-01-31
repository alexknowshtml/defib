# defib 🫀

**System defibrillator** - monitors health and auto-recovers from common failure modes.

When your containers stop responding, processes go runaway, or swap pressure threatens to freeze your system - defib detects the problem and fixes it automatically.

Works with **Docker** or **Podman** (auto-detects).

## What It Does

| Mode | Detects | Auto-Recovery |
|------|---------|---------------|
| `container` | Unresponsive HTTP endpoints | Restarts via docker-compose/podman-compose |
| `processes` | High CPU/memory processes | Kills processes matching safe-to-kill patterns |
| `system` | Swap pressure, stuck processes | Kills memory hogs, restarts services |
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
# Monitor a container - restart if health check fails
bun run defib.ts container --health http://localhost:8000/health --compose-dir ./my-app

# Monitor processes - kill runaway node processes
bun run defib.ts processes --safe-to-kill "node" --ignore "postgres"

# Monitor system - restart app when swap gets critical
bun run defib.ts system --swap-kill "leaky-app" --swap-restart-dir ./my-app

# Monitor everything
bun run defib.ts all --config ./defib.config.json
```

## Commands

### `defib container`

Monitors container health via HTTP endpoint. If the endpoint stops responding or responds too slowly, defib restarts the container via docker-compose/podman-compose.

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
| Flag | Default | Description |
|------|---------|-------------|
| `--health <url>` | required | Health endpoint URL |
| `--compose-dir <path>` | required | Directory with docker-compose.yml |
| `--timeout <sec>` | 10 | Health check timeout |
| `--max-response <sec>` | 15 | Max acceptable response time |
| `--backoff <min>` | 10 | Cooldown between restart attempts |
| `--service <name>` | - | Specific service to restart |

### `defib processes`

Monitors for runaway processes. When a process exceeds CPU or memory thresholds for too long, defib can automatically kill it if it matches a safe-to-kill pattern.

```bash
bun run defib.ts processes \
  --cpu-threshold 80 \
  --memory-threshold 2000 \
  --max-runtime 2 \
  --safe-to-kill "node mcp-" \
  --safe-to-kill "python worker" \
  --ignore "postgres" \
  --ignore "ollama"
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--cpu-threshold <pct>` | 80 | CPU % to flag as runaway |
| `--memory-threshold <mb>` | 2000 | Memory MB to flag |
| `--max-runtime <hours>` | 2 | Hours at high CPU before action |
| `--safe-to-kill <pattern>` | - | Process patterns safe to auto-kill (repeatable) |
| `--ignore <pattern>` | - | Process patterns to skip (repeatable) |

### `defib system`

Monitors system health: swap pressure and stuck processes (D-state). When swap gets critical, defib can kill specified processes or restart a service to free memory.

```bash
bun run defib.ts system \
  --swap-threshold 80 \
  --swap-kill "electron" \
  --swap-kill "chrome" \
  --swap-restart-dir ./my-app \
  --swap-restart-service web
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--swap-threshold <pct>` | 80 | Swap % to trigger action |
| `--swap-kill <pattern>` | - | Process patterns to kill when swap critical (repeatable) |
| `--swap-restart-dir <path>` | - | Compose dir to restart when swap critical |
| `--swap-restart-service <n>` | - | Specific service to restart |
| `--no-dstate` | false | Disable D-state monitoring |

### `defib all`

Runs all monitors. Best used with a config file for complex setups.

```bash
bun run defib.ts all --config ./defib.config.json
```

## Configuration

### Config File

For complex setups, use a JSON config file:

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
    "checkDState": true,
    "swapKillPatterns": ["electron", "chrome"],
    "swapRestartCompose": {
      "composeDir": "/path/to/app",
      "serviceName": "web"
    }
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

defib is designed to run periodically, not as a daemon. Use cron, systemd timers, or PM2.

### With cron

```bash
# Check containers every 2 minutes
*/2 * * * * /path/to/bun /path/to/defib.ts container --health http://localhost:8000/health --compose-dir /app

# Check processes every 15 minutes
*/15 * * * * /path/to/bun /path/to/defib.ts processes --safe-to-kill "node mcp-"

# Full health check every 5 minutes
*/5 * * * * /path/to/bun /path/to/defib.ts all --config /etc/defib/config.json
```

### With PM2

```bash
pm2 start defib.ts --name defib-container --cron "*/2 * * * *" --no-autorestart -- container --health http://localhost:8000/health --compose-dir /app
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
1. HTTP GET to health endpoint with configurable timeout
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
2. If critical → kill matching processes and/or restart compose stack
3. Check for D-state processes via `ps`
4. Skip kernel threads and short D-states (normal I/O)
5. Alert on resolution when issues clear

## Notifications

Supports Discord and Slack webhooks. Notifications include:

- **Container Restarted** - Service was down, now recovered
- **Container Restart FAILED** - Manual intervention needed
- **Runaway Process Killed** - Auto-killed a safe process
- **Runaway Process Detected** - High CPU, needs attention
- **High Memory Process** - Memory hog detected
- **Swap Critical - Auto-Remediated** - Killed processes/restarted services
- **Swap Pressure Critical** - No auto-fix configured, manual action needed
- **Stuck Process Detected** - Process in D-state (uninterruptible sleep)

## State Persistence

defib maintains state in `/tmp/defib-state.json` (configurable):

- Tracks restart backoff timers
- Remembers known issues to avoid duplicate alerts
- Cleans up resolved issues automatically

## Why "defib"?

Like a defibrillator shocks a stopped heart back to life, defib shocks your stopped services back to health. It's the tool you hope you never need, but when you do, it's there.

## License

MIT
