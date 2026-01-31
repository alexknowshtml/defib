#!/usr/bin/env bun
/**
 * defib - System Defibrillator
 *
 * Monitors system health and auto-recovers from common failure modes:
 * - Container health (HTTP endpoints) → auto-restart
 * - Runaway processes (high CPU/memory) → auto-kill
 * - System health (swap pressure, stuck processes) → alert
 *
 * Usage:
 *   defib container --health <url> --compose-dir <path>
 *   defib processes [--kill-threshold 80] [--memory-threshold 2000]
 *   defib system [--swap-threshold 80]
 *   defib all --config ./defib.config.json
 *
 * Environment variables:
 *   DEFIB_WEBHOOK_URL      - Discord/Slack webhook for notifications
 *   DEFIB_HEALTH_URL       - Health endpoint URL (container mode)
 *   DEFIB_COMPOSE_DIR      - docker-compose.yml location (container mode)
 */

import { $ } from "bun";
import { parseArgs } from "util";

// ============================================================================
// Types
// ============================================================================

interface ContainerConfig {
  healthUrl: string;
  composeDir: string;
  timeoutSeconds: number;
  maxResponseSeconds: number;
  backoffMinutes: number;
  containerRuntime: "docker" | "podman";
  serviceName?: string;
}

interface ProcessConfig {
  cpuThreshold: number;        // CPU % to consider "high"
  memoryThresholdMB: number;   // Memory MB to consider "high"
  maxRuntimeHours: number;     // Hours before flagging long-running high-CPU
  safeToKillPatterns: string[];
  ignorePatterns: string[];
}

interface SystemConfig {
  swapThreshold: number;       // Swap % to alert
  checkDState: boolean;        // Monitor D-state processes
  swapKillPatterns: string[];  // Processes to kill when swap critical
  swapRestartCompose?: {       // Compose stack to restart when swap critical
    composeDir: string;
    serviceName?: string;
  };
}

interface Config {
  webhookUrl?: string;
  stateFile: string;
  container?: ContainerConfig;
  processes?: ProcessConfig;
  system?: SystemConfig;
}

interface WatchdogState {
  lastRestartTime: number | null;
  restartCount: number;
  lastCheckTime: number;
  consecutiveFailures: number;
  knownIssues: { [key: string]: number }; // issue key → first seen timestamp
}

interface HealthResult {
  healthy: boolean;
  responseTime: number;
  error?: string;
}

interface ProcessInfo {
  pid: string;
  cpu: number;
  memoryMB: number;
  runtimeHours: number;
  command: string;
  state?: string;
}

interface Issue {
  type: "container" | "runaway" | "memory" | "stuck" | "swap";
  severity: "critical" | "warning" | "info";
  message: string;
  pid?: string;
  command?: string;
  autoKilled?: boolean;
}

// ============================================================================
// Utilities
// ============================================================================

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

function parseEtimeToHours(etime: string): number {
  if (etime.includes("-")) {
    const [days, time] = etime.split("-");
    const [hours] = time.split(":").map(Number);
    return parseInt(days) * 24 + hours;
  } else {
    const parts = etime.split(":").map(Number);
    if (parts.length === 3) {
      return parts[0]; // HH:MM:SS
    } else if (parts.length === 2) {
      return parts[0] / 60; // MM:SS
    }
  }
  return 0;
}

function getIssueKey(issue: Issue): string {
  if (issue.type === "swap") return "swap_critical";
  if (issue.pid) return `${issue.type}:${issue.pid}`;
  return `${issue.type}:${issue.message}`;
}

// ============================================================================
// State Management
// ============================================================================

async function loadState(stateFile: string): Promise<WatchdogState> {
  try {
    const file = Bun.file(stateFile);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // State file doesn't exist or is invalid
  }
  return {
    lastRestartTime: null,
    restartCount: 0,
    lastCheckTime: Date.now(),
    consecutiveFailures: 0,
    knownIssues: {},
  };
}

async function saveState(stateFile: string, state: WatchdogState): Promise<void> {
  await Bun.write(stateFile, JSON.stringify(state, null, 2));
}

// ============================================================================
// Notifications
// ============================================================================

async function sendNotification(
  webhookUrl: string | undefined,
  title: string,
  message: string,
  isError: boolean = false
): Promise<void> {
  console.log(`[${isError ? "ERROR" : "NOTICE"}] ${title}`);
  console.log(`  ${message.replace(/\n/g, "\n  ")}`);

  if (!webhookUrl) return;

  const payload = {
    embeds: [{
      title: isError ? `🔴 ${title}` : `🟡 ${title}`,
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

// ============================================================================
// Container Monitoring
// ============================================================================

async function checkContainerHealth(config: ContainerConfig): Promise<HealthResult> {
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

async function restartContainer(config: ContainerConfig): Promise<boolean> {
  const compose = config.containerRuntime === "docker" ? "docker-compose" : "podman-compose";
  const serviceArg = config.serviceName || "";

  console.log(`  Restarting with ${compose}...`);

  try {
    if (serviceArg) {
      await $`cd ${config.composeDir} && ${compose} down ${serviceArg}`.quiet();
      await $`cd ${config.composeDir} && ${compose} up -d ${serviceArg}`.quiet();
    } else {
      await $`cd ${config.composeDir} && ${compose} down`.quiet();
      await $`cd ${config.composeDir} && ${compose} up -d`.quiet();
    }

    await Bun.sleep(5000);
    const health = await checkContainerHealth(config);
    return health.healthy;
  } catch (error) {
    console.error("  Failed to restart container:", error);
    return false;
  }
}

async function monitorContainer(
  config: ContainerConfig,
  webhookUrl: string | undefined,
  state: WatchdogState
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const now = Date.now();

  // Check backoff
  if (state.lastRestartTime) {
    const minutesSinceRestart = (now - state.lastRestartTime) / 1000 / 60;
    if (minutesSinceRestart < config.backoffMinutes) {
      console.log(`  In backoff (${minutesSinceRestart.toFixed(1)}/${config.backoffMinutes} min)`);
      return issues;
    }
  }

  const health = await checkContainerHealth(config);

  if (health.healthy) {
    console.log(`  ✓ Container healthy (${health.responseTime.toFixed(2)}s)`);
    state.restartCount = 0;
    state.consecutiveFailures = 0;
    return issues;
  }

  state.consecutiveFailures++;
  console.log(`  ✗ Container unhealthy: ${health.error}`);

  const success = await restartContainer(config);

  state.lastRestartTime = now;
  state.restartCount++;

  if (success) {
    state.consecutiveFailures = 0;
    await sendNotification(
      webhookUrl,
      "Container Restarted",
      `**Reason:** ${health.error}\n**Restart count:** ${state.restartCount}\n**Backoff:** ${config.backoffMinutes} min`
    );
  } else {
    issues.push({
      type: "container",
      severity: "critical",
      message: `Container restart failed: ${health.error}`,
    });
    await sendNotification(
      webhookUrl,
      "Container Restart FAILED",
      `**Error:** ${health.error}\n**Manual intervention required.**`,
      true
    );
  }

  return issues;
}

// ============================================================================
// Process Monitoring
// ============================================================================

function killProcess(pid: string, command: string): boolean {
  try {
    const result = Bun.spawnSync(["kill", pid]);
    if (result.exitCode === 0) {
      console.log(`  Killed PID ${pid}: ${command.substring(0, 60)}`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function getProcessList(): Promise<ProcessInfo[]> {
  const processes: ProcessInfo[] = [];

  try {
    const result = await $`ps -eo pid,pcpu,pmem,rss,etime,state,args --sort=-pcpu`.text();
    const lines = result.trim().split("\n").slice(1); // Skip header

    for (const line of lines) {
      const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S)\s+(.+)$/);
      if (!match) continue;

      const [, pid, cpu, , rss, etime, state, command] = match;
      processes.push({
        pid,
        cpu: parseFloat(cpu),
        memoryMB: parseInt(rss) / 1024,
        runtimeHours: parseEtimeToHours(etime),
        command: command.trim(),
        state,
      });
    }
  } catch (error) {
    console.error("  Failed to get process list:", error);
  }

  return processes;
}

async function monitorProcesses(
  config: ProcessConfig,
  webhookUrl: string | undefined,
  state: WatchdogState
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const processes = await getProcessList();

  for (const proc of processes) {
    // Skip ignored processes
    if (config.ignorePatterns.some(p => proc.command.includes(p))) continue;

    // Check for runaway CPU
    if (proc.cpu > config.cpuThreshold && proc.runtimeHours > config.maxRuntimeHours) {
      const safeToKill = config.safeToKillPatterns.some(p => proc.command.includes(p));
      let killed = false;

      if (safeToKill) {
        killed = killProcess(proc.pid, proc.command);
      }

      const issue: Issue = {
        type: "runaway",
        severity: killed ? "warning" : "critical",
        message: `PID ${proc.pid}: ${proc.cpu}% CPU for ${proc.runtimeHours.toFixed(1)}h`,
        pid: proc.pid,
        command: proc.command,
        autoKilled: killed,
      };

      // Only report if new
      const key = getIssueKey(issue);
      if (!state.knownIssues[key]) {
        state.knownIssues[key] = Date.now();
        issues.push(issue);

        if (killed) {
          await sendNotification(
            webhookUrl,
            "Runaway Process Killed",
            `**PID:** ${proc.pid}\n**CPU:** ${proc.cpu}%\n**Runtime:** ${proc.runtimeHours.toFixed(1)}h\n\`${proc.command.substring(0, 100)}\``
          );
        } else {
          await sendNotification(
            webhookUrl,
            "Runaway Process Detected",
            `**PID:** ${proc.pid}\n**CPU:** ${proc.cpu}%\n**Runtime:** ${proc.runtimeHours.toFixed(1)}h\n\`${proc.command.substring(0, 100)}\`\n\n**Manual intervention may be required.**`,
            true
          );
        }
      }
    }

    // Check for memory hogs
    if (proc.memoryMB > config.memoryThresholdMB && proc.runtimeHours > 1) {
      const issue: Issue = {
        type: "memory",
        severity: "warning",
        message: `PID ${proc.pid}: ${proc.memoryMB.toFixed(0)}MB memory`,
        pid: proc.pid,
        command: proc.command,
      };

      const key = getIssueKey(issue);
      if (!state.knownIssues[key]) {
        state.knownIssues[key] = Date.now();
        issues.push(issue);

        await sendNotification(
          webhookUrl,
          "High Memory Process",
          `**PID:** ${proc.pid}\n**Memory:** ${proc.memoryMB.toFixed(0)}MB\n**Runtime:** ${proc.runtimeHours.toFixed(1)}h\n\`${proc.command.substring(0, 100)}\``
        );
      }
    }
  }

  // Clean up resolved issues
  const currentPids = new Set(processes.map(p => p.pid));
  for (const key of Object.keys(state.knownIssues)) {
    const pid = key.split(":")[1];
    if (pid && !currentPids.has(pid)) {
      delete state.knownIssues[key];
    }
  }

  if (issues.length === 0) {
    console.log(`  ✓ Processes healthy`);
  }

  return issues;
}

// ============================================================================
// System Monitoring
// ============================================================================

async function monitorSystem(
  config: SystemConfig,
  webhookUrl: string | undefined,
  state: WatchdogState,
  containerRuntime?: "docker" | "podman"
): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Check swap usage
  try {
    const memInfo = await $`free -m`.text();
    const swapMatch = memInfo.match(/Swap:\s+(\d+)\s+(\d+)/);
    if (swapMatch) {
      const [, total, used] = swapMatch.map(Number);
      const swapPercent = total > 0 ? (used / total) * 100 : 0;

      if (swapPercent > config.swapThreshold) {
        const key = "swap_critical";
        const isNewIssue = !state.knownIssues[key];

        if (isNewIssue) {
          state.knownIssues[key] = Date.now();
        }

        // Auto-remediation: kill matching processes
        const killed: string[] = [];
        if (config.swapKillPatterns.length > 0) {
          const processes = await getProcessList();
          for (const proc of processes) {
            if (config.swapKillPatterns.some(p => proc.command.includes(p))) {
              if (killProcess(proc.pid, proc.command)) {
                killed.push(`PID ${proc.pid}: ${proc.command.substring(0, 50)}`);
              }
            }
          }
        }

        // Auto-remediation: restart compose stack
        let restarted = false;
        if (config.swapRestartCompose && containerRuntime) {
          const compose = containerRuntime === "docker" ? "docker-compose" : "podman-compose";
          const { composeDir, serviceName } = config.swapRestartCompose;
          console.log(`  Restarting ${serviceName || "stack"} to free memory...`);
          try {
            if (serviceName) {
              await $`cd ${composeDir} && ${compose} restart ${serviceName}`.quiet();
            } else {
              await $`cd ${composeDir} && ${compose} down`.quiet();
              await $`cd ${composeDir} && ${compose} up -d`.quiet();
            }
            restarted = true;
          } catch (error) {
            console.error(`  Failed to restart compose: ${error}`);
          }
        }

        const issue: Issue = {
          type: "swap",
          severity: "critical",
          message: `Swap usage: ${swapPercent.toFixed(1)}% (${used}MB / ${total}MB)`,
        };
        issues.push(issue);

        if (isNewIssue || killed.length > 0 || restarted) {
          let remediation = "";
          if (killed.length > 0) {
            remediation += `\n\n**Auto-killed ${killed.length} process(es):**\n${killed.join("\n")}`;
          }
          if (restarted) {
            remediation += `\n\n**Restarted:** ${config.swapRestartCompose?.serviceName || "compose stack"}`;
          }
          if (!killed.length && !restarted) {
            remediation = "\n\n**No auto-remediation configured.** System may become unresponsive.";
          }

          await sendNotification(
            webhookUrl,
            killed.length > 0 || restarted ? "Swap Critical - Auto-Remediated" : "Swap Pressure Critical",
            `**Usage:** ${swapPercent.toFixed(1)}%\n**Used:** ${used}MB / ${total}MB${remediation}`,
            !killed.length && !restarted
          );
        }
      } else if (state.knownIssues["swap_critical"]) {
        delete state.knownIssues["swap_critical"];
        await sendNotification(
          webhookUrl,
          "Swap Pressure Resolved",
          `**Usage:** ${swapPercent.toFixed(1)}%`
        );
      }
    }
  } catch (error) {
    console.error("  Failed to check swap:", error);
  }

  // Check for D-state processes
  if (config.checkDState) {
    try {
      const result = await $`ps -eo pid,state,etime,args | grep "^\\s*[0-9]\\+\\s\\+D"`.text().catch(() => "");
      const lines = result.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+D\s+(\S+)\s+(.+)$/);
        if (match) {
          const [, pid, etime, command] = match;

          // Skip very short D-states (normal I/O)
          if (!etime.includes(":") || etime.startsWith("00:0")) continue;

          // Skip kernel threads
          if (command.includes("kworker/") || command.includes("jbd2/")) continue;

          const issue: Issue = {
            type: "stuck",
            severity: "warning",
            message: `PID ${pid}: Stuck in D-state for ${etime}`,
            pid,
            command: command.trim(),
          };

          const key = getIssueKey(issue);
          if (!state.knownIssues[key]) {
            state.knownIssues[key] = Date.now();
            issues.push(issue);

            await sendNotification(
              webhookUrl,
              "Stuck Process Detected",
              `**PID:** ${pid}\n**Duration:** ${etime}\n\`${command.substring(0, 100)}\`\n\n**Process in uninterruptible sleep.**`
            );
          }
        }
      }
    } catch {
      // No D-state processes found
    }
  }

  if (issues.length === 0) {
    console.log(`  ✓ System healthy`);
  }

  return issues;
}

// ============================================================================
// CLI
// ============================================================================

function printHelp() {
  console.log(`
defib - System Defibrillator

Monitors system health and auto-recovers from common failure modes.

Usage:
  defib container --health <url> --compose-dir <path> [options]
  defib processes [options]
  defib system [options]
  defib all --config <file>

Commands:
  container   Monitor container health via HTTP endpoint, auto-restart if unhealthy
  processes   Monitor for runaway processes (high CPU/memory), auto-kill if safe
  system      Monitor system health (swap pressure, stuck processes)
  all         Run all monitors (requires config file)

Container Options:
  --health <url>         Health endpoint URL (required)
  --compose-dir <path>   Directory with docker-compose.yml (required)
  --timeout <sec>        Health check timeout (default: 10)
  --max-response <sec>   Max acceptable response time (default: 15)
  --backoff <min>        Minutes between restart attempts (default: 10)
  --service <name>       Specific service to restart

Process Options:
  --cpu-threshold <pct>     CPU % to flag (default: 80)
  --memory-threshold <mb>   Memory MB to flag (default: 2000)
  --max-runtime <hours>     Hours before flagging high-CPU process (default: 2)
  --safe-to-kill <pattern>  Process pattern safe to auto-kill (repeatable)
  --ignore <pattern>        Process pattern to ignore (repeatable)

System Options:
  --swap-threshold <pct>       Swap % to trigger action (default: 80)
  --swap-kill <pattern>        Process pattern to kill when swap critical (repeatable)
  --swap-restart-dir <path>    Compose dir to restart when swap critical
  --swap-restart-service <n>   Specific service to restart (optional)
  --no-dstate                  Disable D-state monitoring

Global Options:
  --webhook <url>        Discord/Slack webhook for notifications
  --config <file>        Load config from JSON file
  --state-file <path>    State file location (default: /tmp/defib-state.json)
  --help                 Show this help

Environment Variables:
  DEFIB_WEBHOOK_URL, DEFIB_HEALTH_URL, DEFIB_COMPOSE_DIR
`);
}

async function main() {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const restArgs = args.slice(1);

  const { values } = parseArgs({
    args: restArgs,
    options: {
      // Global
      config: { type: "string", short: "c" },
      webhook: { type: "string", short: "w" },
      "state-file": { type: "string" },
      // Container
      health: { type: "string" },
      "compose-dir": { type: "string", short: "d" },
      timeout: { type: "string", short: "t" },
      "max-response": { type: "string" },
      backoff: { type: "string", short: "b" },
      service: { type: "string", short: "s" },
      // Processes
      "cpu-threshold": { type: "string" },
      "memory-threshold": { type: "string" },
      "max-runtime": { type: "string" },
      "safe-to-kill": { type: "string", multiple: true },
      ignore: { type: "string", multiple: true },
      // System
      "swap-threshold": { type: "string" },
      "swap-kill": { type: "string", multiple: true },
      "swap-restart-dir": { type: "string" },
      "swap-restart-service": { type: "string" },
      "no-dstate": { type: "boolean" },
    },
    allowPositionals: true,
  });

  // Load file config if provided
  let fileConfig: any = {};
  if (values.config) {
    const file = Bun.file(values.config);
    if (await file.exists()) {
      fileConfig = await file.json();
    }
  }

  const webhookUrl = values.webhook || process.env.DEFIB_WEBHOOK_URL || fileConfig.webhookUrl;
  const stateFile = values["state-file"] || fileConfig.stateFile || "/tmp/defib-state.json";

  const state = await loadState(stateFile);
  const now = Date.now();

  console.log(`[${new Date().toISOString()}] defib ${command}`);

  let allIssues: Issue[] = [];

  if (command === "container" || command === "all") {
    const healthUrl = values.health || process.env.DEFIB_HEALTH_URL || fileConfig.container?.healthUrl;
    const composeDir = values["compose-dir"] || process.env.DEFIB_COMPOSE_DIR || fileConfig.container?.composeDir;

    if (!healthUrl || !composeDir) {
      if (command === "container") {
        console.error("Error: --health and --compose-dir are required for container mode");
        process.exit(1);
      }
    } else {
      const runtime = await detectRuntime();
      const containerConfig: ContainerConfig = {
        healthUrl,
        composeDir,
        timeoutSeconds: parseInt(values.timeout || "") || fileConfig.container?.timeoutSeconds || 10,
        maxResponseSeconds: parseInt(values["max-response"] || "") || fileConfig.container?.maxResponseSeconds || 15,
        backoffMinutes: parseInt(values.backoff || "") || fileConfig.container?.backoffMinutes || 10,
        containerRuntime: runtime,
        serviceName: values.service || fileConfig.container?.serviceName,
      };
      console.log(`  Runtime: ${runtime}`);
      const issues = await monitorContainer(containerConfig, webhookUrl, state);
      allIssues = allIssues.concat(issues);
    }
  }

  if (command === "processes" || command === "all") {
    const processConfig: ProcessConfig = {
      cpuThreshold: parseInt(values["cpu-threshold"] || "") || fileConfig.processes?.cpuThreshold || 80,
      memoryThresholdMB: parseInt(values["memory-threshold"] || "") || fileConfig.processes?.memoryThresholdMB || 2000,
      maxRuntimeHours: parseInt(values["max-runtime"] || "") || fileConfig.processes?.maxRuntimeHours || 2,
      safeToKillPatterns: values["safe-to-kill"] || fileConfig.processes?.safeToKillPatterns || [],
      ignorePatterns: values.ignore || fileConfig.processes?.ignorePatterns || [],
    };
    const issues = await monitorProcesses(processConfig, webhookUrl, state);
    allIssues = allIssues.concat(issues);
  }

  if (command === "system" || command === "all") {
    // Detect runtime for swap restart feature
    let runtime: "docker" | "podman" | undefined;
    const swapRestartDir = values["swap-restart-dir"] || fileConfig.system?.swapRestartCompose?.composeDir;
    if (swapRestartDir) {
      runtime = await detectRuntime();
    }

    const systemConfig: SystemConfig = {
      swapThreshold: parseInt(values["swap-threshold"] || "") || fileConfig.system?.swapThreshold || 80,
      checkDState: !values["no-dstate"] && (fileConfig.system?.checkDState !== false),
      swapKillPatterns: values["swap-kill"] || fileConfig.system?.swapKillPatterns || [],
      swapRestartCompose: swapRestartDir ? {
        composeDir: swapRestartDir,
        serviceName: values["swap-restart-service"] || fileConfig.system?.swapRestartCompose?.serviceName,
      } : undefined,
    };
    const issues = await monitorSystem(systemConfig, webhookUrl, state, runtime);
    allIssues = allIssues.concat(issues);
  }

  if (!["container", "processes", "system", "all"].includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error("Run 'defib --help' for usage");
    process.exit(1);
  }

  state.lastCheckTime = now;
  await saveState(stateFile, state);

  if (allIssues.length > 0) {
    console.log(`\n  Found ${allIssues.length} issue(s)`);
    process.exit(1);
  }
}

main().catch(console.error);
