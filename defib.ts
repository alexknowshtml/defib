#!/usr/bin/env bun
/**
 * defib - Container Defibrillator
 *
 * Monitors container health endpoints and auto-restarts unresponsive services.
 * Works with Docker or Podman (auto-detects).
 *
 * Usage:
 *   defib --config ./defib.config.json
 *   defib --health http://localhost:8000/health --compose-dir ./my-app
 *
 * Environment variables:
 *   DEFIB_HEALTH_URL       - Health endpoint URL
 *   DEFIB_COMPOSE_DIR      - Directory containing docker-compose.yml
 *   DEFIB_WEBHOOK_URL      - Discord/Slack webhook for notifications (optional)
 *   DEFIB_TIMEOUT          - Health check timeout in seconds (default: 10)
 *   DEFIB_MAX_RESPONSE     - Max acceptable response time in seconds (default: 15)
 *   DEFIB_BACKOFF          - Minutes to wait between restart attempts (default: 10)
 */

import { $ } from "bun";
import { parseArgs } from "util";

// Types
interface Config {
  healthUrl: string;
  composeDir: string;
  webhookUrl?: string;
  timeoutSeconds: number;
  maxResponseSeconds: number;
  backoffMinutes: number;
  containerRuntime: "docker" | "podman";
  stateFile: string;
  serviceName?: string;
}

interface WatchdogState {
  lastRestartTime: number | null;
  restartCount: number;
  lastCheckTime: number;
  consecutiveFailures: number;
}

interface HealthResult {
  healthy: boolean;
  responseTime: number;
  error?: string;
}

// Detect container runtime
async function detectRuntime(): Promise<"docker" | "podman"> {
  try {
    await $`docker --version`.quiet();
    return "docker";
  } catch {
    try {
      await $`podman --version`.quiet();
      return "podman";
    } catch {
      throw new Error("Neither docker nor podman found in PATH");
    }
  }
}

// Load config from file, CLI args, or environment
async function loadConfig(): Promise<Config> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", short: "c" },
      health: { type: "string", short: "h" },
      "compose-dir": { type: "string", short: "d" },
      webhook: { type: "string", short: "w" },
      timeout: { type: "string", short: "t" },
      "max-response": { type: "string" },
      backoff: { type: "string", short: "b" },
      service: { type: "string", short: "s" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
defib - Container Defibrillator

Monitors container health and auto-restarts unresponsive services.

Usage:
  defib --health <url> --compose-dir <path> [options]
  defib --config <file>

Options:
  -h, --health <url>       Health endpoint URL (required)
  -d, --compose-dir <path> Directory with docker-compose.yml (required)
  -w, --webhook <url>      Discord/Slack webhook for notifications
  -t, --timeout <sec>      Health check timeout (default: 10)
  --max-response <sec>     Max acceptable response time (default: 15)
  -b, --backoff <min>      Minutes between restart attempts (default: 10)
  -s, --service <name>     Specific service to restart (optional)
  -c, --config <file>      Load config from JSON file

Environment variables:
  DEFIB_HEALTH_URL, DEFIB_COMPOSE_DIR, DEFIB_WEBHOOK_URL,
  DEFIB_TIMEOUT, DEFIB_MAX_RESPONSE, DEFIB_BACKOFF
`);
    process.exit(0);
  }

  let fileConfig: Partial<Config> = {};
  if (values.config) {
    const file = Bun.file(values.config);
    if (await file.exists()) {
      fileConfig = await file.json();
    }
  }

  const healthUrl = values.health || process.env.DEFIB_HEALTH_URL || fileConfig.healthUrl;
  const composeDir = values["compose-dir"] || process.env.DEFIB_COMPOSE_DIR || fileConfig.composeDir;

  if (!healthUrl || !composeDir) {
    console.error("Error: --health and --compose-dir are required");
    process.exit(1);
  }

  const runtime = await detectRuntime();

  return {
    healthUrl,
    composeDir,
    webhookUrl: values.webhook || process.env.DEFIB_WEBHOOK_URL || fileConfig.webhookUrl,
    timeoutSeconds: parseInt(values.timeout || process.env.DEFIB_TIMEOUT || "") || fileConfig.timeoutSeconds || 10,
    maxResponseSeconds: parseInt(values["max-response"] || process.env.DEFIB_MAX_RESPONSE || "") || fileConfig.maxResponseSeconds || 15,
    backoffMinutes: parseInt(values.backoff || process.env.DEFIB_BACKOFF || "") || fileConfig.backoffMinutes || 10,
    containerRuntime: runtime,
    stateFile: `/tmp/defib-${composeDir.replace(/\//g, "-")}.json`,
    serviceName: values.service || fileConfig.serviceName,
  };
}

// State management
async function loadState(stateFile: string): Promise<WatchdogState> {
  try {
    const file = Bun.file(stateFile);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // State file doesn't exist or is invalid
  }
  return { lastRestartTime: null, restartCount: 0, lastCheckTime: Date.now(), consecutiveFailures: 0 };
}

async function saveState(stateFile: string, state: WatchdogState): Promise<void> {
  await Bun.write(stateFile, JSON.stringify(state, null, 2));
}

// Notifications
async function sendNotification(
  webhookUrl: string | undefined,
  message: string,
  isError: boolean = false
): Promise<void> {
  if (!webhookUrl) return;

  const payload = {
    embeds: [{
      title: isError ? "🔴 Defib Alert" : "🟡 Defib Notice",
      description: message,
      color: isError ? 15158332 : 16776960,
      timestamp: new Date().toISOString(),
      footer: { text: "defib" }
    }]
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error(`Notification failed: ${response.status}`);
    }
  } catch (error) {
    console.error("Failed to send notification:", error);
  }
}

// Health check
async function checkHealth(config: Config): Promise<HealthResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);

  const startTime = Date.now();

  try {
    const response = await fetch(config.healthUrl, { signal: controller.signal });
    clearTimeout(timeout);

    const responseTime = (Date.now() - startTime) / 1000;

    if (!response.ok) {
      return { healthy: false, responseTime, error: `HTTP ${response.status}` };
    }

    if (responseTime > config.maxResponseSeconds) {
      return { healthy: false, responseTime, error: `Slow response: ${responseTime.toFixed(1)}s` };
    }

    return { healthy: true, responseTime };
  } catch (error) {
    clearTimeout(timeout);
    const responseTime = (Date.now() - startTime) / 1000;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return { healthy: false, responseTime, error: errorMessage };
  }
}

// Container restart
async function restartContainer(config: Config): Promise<boolean> {
  const compose = config.containerRuntime === "docker" ? "docker-compose" : "podman-compose";
  const serviceArg = config.serviceName ? ` ${config.serviceName}` : "";

  console.log(`Restarting with ${compose}...`);

  try {
    await $`cd ${config.composeDir} && ${compose} down${serviceArg}`.quiet();
    await $`cd ${config.composeDir} && ${compose} up -d${serviceArg}`.quiet();

    // Wait for container to start
    await Bun.sleep(5000);

    // Verify health
    const health = await checkHealth(config);
    return health.healthy;
  } catch (error) {
    console.error("Failed to restart container:", error);
    return false;
  }
}

// Main
async function main() {
  const config = await loadConfig();
  const now = Date.now();

  console.log(`[${new Date().toISOString()}] defib health check`);
  console.log(`  Runtime: ${config.containerRuntime}`);
  console.log(`  Health URL: ${config.healthUrl}`);

  const state = await loadState(config.stateFile);

  // Check backoff period
  if (state.lastRestartTime) {
    const minutesSinceRestart = (now - state.lastRestartTime) / 1000 / 60;
    if (minutesSinceRestart < config.backoffMinutes) {
      console.log(`  In backoff (${minutesSinceRestart.toFixed(1)}/${config.backoffMinutes} min). Skipping.`);
      state.lastCheckTime = now;
      await saveState(config.stateFile, state);
      return;
    }
  }

  const health = await checkHealth(config);

  if (health.healthy) {
    console.log(`  ✓ Healthy (${health.responseTime.toFixed(2)}s)`);
    state.restartCount = 0;
    state.consecutiveFailures = 0;
    state.lastCheckTime = now;
    await saveState(config.stateFile, state);
    return;
  }

  state.consecutiveFailures++;
  console.log(`  ✗ Unhealthy: ${health.error} (failure #${state.consecutiveFailures})`);

  // Restart
  const success = await restartContainer(config);

  state.lastRestartTime = now;
  state.restartCount++;
  state.lastCheckTime = now;
  await saveState(config.stateFile, state);

  if (success) {
    state.consecutiveFailures = 0;
    await saveState(config.stateFile, state);

    await sendNotification(
      config.webhookUrl,
      `Container restarted successfully.\n\n` +
      `**Reason:** ${health.error}\n` +
      `**Restart count:** ${state.restartCount}\n` +
      `**Backoff:** ${config.backoffMinutes} min`
    );
    console.log("  Restart successful");
  } else {
    await sendNotification(
      config.webhookUrl,
      `Container restart failed!\n\n` +
      `**Error:** ${health.error}\n` +
      `**Manual intervention required.**`,
      true
    );
    console.log("  Restart FAILED - manual intervention needed");
  }
}

main().catch(console.error);
