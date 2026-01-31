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

// Action modes: auto (execute immediately), ask (show guidance), deny (alert only)
type ActionMode = "auto" | "ask" | "deny";

interface ActionConfig {
  restartContainer: ActionMode;    // Restart unhealthy containers
  killRunaway: ActionMode;         // Kill high-CPU processes (safe patterns)
  killUnknown: ActionMode;         // Kill high-CPU processes (unknown)
  killSwapHog: ActionMode;         // Kill processes when swap critical
  restartForSwap: ActionMode;      // Restart compose when swap critical
}

interface Config {
  webhookUrl?: string;
  stateFile: string;
  container?: ContainerConfig;
  processes?: ProcessConfig;
  system?: SystemConfig;
  actions?: Partial<ActionConfig>;
}

// Conservative defaults - only safe patterns auto-execute
const DEFAULT_ACTIONS: ActionConfig = {
  restartContainer: "auto",   // Containers are designed to restart
  killRunaway: "auto",        // Only kills safe-to-kill patterns
  killUnknown: "ask",         // Needs human review
  killSwapHog: "ask",         // Needs human review
  restartForSwap: "ask",      // Needs human review
};

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
// Security Validations
// ============================================================================

function validatePatterns(patterns: string[], name: string): void {
  for (const pattern of patterns) {
    // Reject empty or too-short patterns that would match everything
    if (!pattern || pattern.length < 3) {
      throw new Error(`Invalid ${name} pattern: "${pattern}" - patterns must be at least 3 characters`);
    }
    // Reject patterns that are just wildcards or common substrings
    const dangerous = [".", "..", "/", "\\", " ", "node", "python", "bash", "sh"];
    if (dangerous.includes(pattern.toLowerCase())) {
      throw new Error(`Dangerous ${name} pattern: "${pattern}" - too broad, could match critical processes`);
    }
  }
}

function validatePath(path: string, name: string): void {
  // Reject paths with shell metacharacters
  const dangerous = /[;&|`$(){}[\]<>!#*?~]/;
  if (dangerous.test(path)) {
    throw new Error(`Invalid ${name}: "${path}" - contains shell metacharacters`);
  }
  // Must be absolute path
  if (!path.startsWith("/")) {
    throw new Error(`Invalid ${name}: "${path}" - must be an absolute path`);
  }
}

function getSecureStateDir(): string {
  // Use XDG_STATE_HOME or fall back to ~/.local/state
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState) return `${xdgState}/defib`;
  const home = process.env.HOME;
  if (home) return `${home}/.local/state/defib`;
  // Last resort: /tmp with user-specific dir
  return `/tmp/defib-${process.getuid?.() || 'unknown'}`;
}

// ============================================================================
// Human-Friendly Guidance (for "ask" mode)
// ============================================================================

interface Guidance {
  title: string;
  problem: string;
  why: string;
  recommendation: string;
  fixCommand: string;
  investigateCommands: string[];
  dismissCommand: string;
}

function generateGuidance(
  type: "runaway" | "memory" | "swap" | "stuck" | "container",
  details: {
    pid?: string;
    command?: string;
    cpu?: number;
    memoryMB?: number;
    runtimeHours?: number;
    swapPercent?: number;
    healthUrl?: string;
    composeDir?: string;
    serviceName?: string;
  }
): Guidance {
  const { pid, command, cpu, memoryMB, runtimeHours, swapPercent, healthUrl, composeDir, serviceName } = details;
  const shortCommand = command?.substring(0, 60) || "unknown";

  switch (type) {
    case "runaway":
      return {
        title: "ISSUE DETECTED: Runaway Process",
        problem: `PID ${pid} is using ${cpu?.toFixed(0)}% CPU and has been running for ${runtimeHours?.toFixed(1)} hours.\nProcess: ${shortCommand}`,
        why: `This process is consuming almost all available CPU, which slows down everything else on your system. After ${runtimeHours?.toFixed(0)}+ hours at this level, it's likely stuck in a loop rather than doing useful work.`,
        recommendation: `Kill the process. It will free up CPU immediately. If this is a managed service (PM2, systemd, Docker), it will auto-restart fresh.`,
        fixCommand: `kill ${pid}`,
        investigateCommands: [
          `ps -p ${pid} -o pid,pcpu,pmem,etime,args`,
          `cat /proc/${pid}/wchan 2>/dev/null`,
          `ls -la /proc/${pid}/fd 2>/dev/null | wc -l`,
        ],
        dismissCommand: `defib dismiss ${pid}`,
      };

    case "memory":
      return {
        title: "ISSUE DETECTED: High Memory Process",
        problem: `PID ${pid} is using ${memoryMB?.toFixed(0)}MB of memory.\nProcess: ${shortCommand}`,
        why: `This process is consuming a large amount of RAM, which can cause swap pressure and slow down your entire system. If it continues growing, the system may become unresponsive.`,
        recommendation: `If this is unexpected memory usage, kill the process. If it's normal for this application, consider adding it to the ignore list.`,
        fixCommand: `kill ${pid}`,
        investigateCommands: [
          `ps -p ${pid} -o pid,rss,vsz,pmem,args`,
          `cat /proc/${pid}/status | grep -E "VmRSS|VmSwap"`,
        ],
        dismissCommand: `defib dismiss ${pid}`,
      };

    case "swap":
      return {
        title: "ISSUE DETECTED: Critical Swap Pressure",
        problem: `Swap usage is at ${swapPercent?.toFixed(1)}%, which is critically high.`,
        why: `When swap usage is this high, your system is running out of physical memory and is heavily using disk as virtual memory. This makes everything extremely slow and can cause applications to crash or the system to freeze entirely.`,
        recommendation: `Identify and kill memory-hungry processes that aren't essential, or restart services known to have memory leaks. This will free up RAM and reduce swap usage.`,
        fixCommand: `# Find top memory consumers:\nps aux --sort=-%mem | head -20`,
        investigateCommands: [
          `free -h`,
          `ps aux --sort=-%mem | head -10`,
          `cat /proc/meminfo | grep -E "MemFree|SwapFree|Cached"`,
        ],
        dismissCommand: `# Swap alerts auto-clear when usage drops below threshold`,
      };

    case "stuck":
      return {
        title: "ISSUE DETECTED: Stuck Process (D-state)",
        problem: `PID ${pid} is stuck in uninterruptible sleep (D-state).\nProcess: ${shortCommand}`,
        why: `D-state means the process is waiting on I/O (usually disk) and cannot be interrupted. This is sometimes normal (heavy disk activity), but if it persists for a long time, it usually indicates a problem like a failed disk, NFS hang, or kernel issue.`,
        recommendation: `First investigate what it's waiting on. If it's been stuck for a long time with no I/O activity, the underlying cause needs to be addressed. Killing D-state processes usually doesn't work - they're unkillable until the I/O completes.`,
        fixCommand: `# D-state processes are typically unkillable. Check the underlying issue first.`,
        investigateCommands: [
          `cat /proc/${pid}/wchan 2>/dev/null`,
          `cat /proc/${pid}/io 2>/dev/null`,
          `dmesg | tail -50 | grep -i -E "error|fail|timeout"`,
        ],
        dismissCommand: `defib dismiss ${pid}`,
      };

    case "container":
      return {
        title: "ISSUE DETECTED: Unhealthy Container",
        problem: `Container health check failed.\nHealth URL: ${healthUrl}`,
        why: `The container is not responding to health checks, which means the service inside is either crashed, hung, or overloaded. Users or dependent services may be affected.`,
        recommendation: `Restart the container. Docker/Podman Compose will bring it back up with a fresh state. If this happens repeatedly, check the application logs for the root cause.`,
        fixCommand: serviceName
          ? `cd ${composeDir} && docker-compose restart ${serviceName}`
          : `cd ${composeDir} && docker-compose down && docker-compose up -d`,
        investigateCommands: [
          `curl -v ${healthUrl}`,
          `cd ${composeDir} && docker-compose logs --tail=50`,
          `cd ${composeDir} && docker-compose ps`,
        ],
        dismissCommand: `# Container alerts auto-clear when health check passes`,
      };
  }
}

function printGuidance(guidance: Guidance): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔴 ${guidance.title}`);
  console.log(`${"=".repeat(60)}\n`);

  console.log(`${guidance.problem}\n`);

  console.log(`WHY THIS IS A PROBLEM:`);
  console.log(`${guidance.why}\n`);

  console.log(`RECOMMENDED FIX:`);
  console.log(`${guidance.recommendation}\n`);

  console.log(`TO FIX, RUN:`);
  console.log(`  ${guidance.fixCommand}\n`);

  console.log(`TO INVESTIGATE FIRST:`);
  for (const cmd of guidance.investigateCommands) {
    console.log(`  ${cmd}`);
  }
  console.log();

  console.log(`TO IGNORE THIS ALERT:`);
  console.log(`  ${guidance.dismissCommand}`);
  console.log(`${"=".repeat(60)}\n`);
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
  // Ensure directory exists
  const dir = stateFile.substring(0, stateFile.lastIndexOf('/'));
  if (dir) {
    try {
      await $`mkdir -p ${dir} && chmod 700 ${dir}`.quiet();
    } catch {
      // Directory might already exist
    }
  }
  await Bun.write(stateFile, JSON.stringify(state, null, 2));
  // Set restrictive permissions on state file (owner-only read/write)
  try {
    await $`chmod 600 ${stateFile}`.quiet();
  } catch {
    // May fail on some systems, not critical
  }
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
  state: WatchdogState,
  actions: ActionConfig = DEFAULT_ACTIONS
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const processes = await getProcessList();

  for (const proc of processes) {
    // Skip ignored processes
    if (config.ignorePatterns.some(p => proc.command.includes(p))) continue;

    // Check for runaway CPU
    if (proc.cpu > config.cpuThreshold && proc.runtimeHours > config.maxRuntimeHours) {
      const safeToKill = config.safeToKillPatterns.some(p => proc.command.includes(p));
      const actionMode = safeToKill ? actions.killRunaway : actions.killUnknown;
      let killed = false;

      // Determine action based on mode
      if (actionMode === "auto" && safeToKill) {
        killed = killProcess(proc.pid, proc.command);
      } else if (actionMode === "ask") {
        // Print human-friendly guidance
        const guidance = generateGuidance("runaway", {
          pid: proc.pid,
          command: proc.command,
          cpu: proc.cpu,
          runtimeHours: proc.runtimeHours,
        });
        printGuidance(guidance);
      }
      // "deny" mode: just alert, no action or guidance

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
        } else if (actionMode !== "ask") {
          // Only send notification if not in ask mode (ask mode prints to console)
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

        // Memory issues always get guidance in ask mode
        if (actions.killUnknown === "ask") {
          const guidance = generateGuidance("memory", {
            pid: proc.pid,
            command: proc.command,
            memoryMB: proc.memoryMB,
            runtimeHours: proc.runtimeHours,
          });
          printGuidance(guidance);
        } else {
          await sendNotification(
            webhookUrl,
            "High Memory Process",
            `**PID:** ${proc.pid}\n**Memory:** ${proc.memoryMB.toFixed(0)}MB\n**Runtime:** ${proc.runtimeHours.toFixed(1)}h\n\`${proc.command.substring(0, 100)}\``
          );
        }
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
  defib dismiss <pid>     Suppress alerts for a specific process

Commands:
  container   Monitor container health via HTTP endpoint, auto-restart if unhealthy
  processes   Monitor for runaway processes (high CPU/memory), auto-kill if safe
  system      Monitor system health (swap pressure, stuck processes)
  all         Run all monitors (requires config file)
  dismiss     Suppress future alerts for a PID (until it exits)

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

Action Modes (in config file):
  Actions can be set to: "auto" (execute), "ask" (show guidance), "deny" (alert only)

  Default modes (conservative):
    restartContainer: auto    - Containers are designed to restart
    killRunaway: auto         - Only kills safe-to-kill patterns
    killUnknown: ask          - Unknown processes need human review
    killSwapHog: ask          - Swap remediation needs human review
    restartForSwap: ask       - Restarting services needs human review

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
  const defaultStateFile = `${getSecureStateDir()}/state.json`;
  const stateFile = values["state-file"] || fileConfig.stateFile || defaultStateFile;

  const state = await loadState(stateFile);
  const now = Date.now();

  // Build action config from file config with defaults
  const actions: ActionConfig = {
    ...DEFAULT_ACTIONS,
    ...fileConfig.actions,
  };

  // Handle dismiss command
  if (command === "dismiss") {
    const pid = restArgs[0];
    if (!pid) {
      console.error("Error: dismiss requires a PID argument");
      console.error("Usage: defib dismiss <pid>");
      process.exit(1);
    }

    // Add to known issues so it won't be re-alerted
    const keys = [
      `runaway:${pid}`,
      `memory:${pid}`,
      `stuck:${pid}`,
    ];
    for (const key of keys) {
      state.knownIssues[key] = Date.now();
    }
    await saveState(stateFile, state);

    console.log(`Dismissed alerts for PID ${pid}. Will not re-alert until process exits.`);
    process.exit(0);
  }

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
      // Validate composeDir path
      validatePath(composeDir, "compose-dir");
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
    const safeToKillPatterns = values["safe-to-kill"] || fileConfig.processes?.safeToKillPatterns || [];
    const ignorePatterns = values.ignore || fileConfig.processes?.ignorePatterns || [];

    // Validate patterns to prevent overly broad matches
    if (safeToKillPatterns.length > 0) {
      validatePatterns(safeToKillPatterns, "safe-to-kill");
    }

    const processConfig: ProcessConfig = {
      cpuThreshold: parseInt(values["cpu-threshold"] || "") || fileConfig.processes?.cpuThreshold || 80,
      memoryThresholdMB: parseInt(values["memory-threshold"] || "") || fileConfig.processes?.memoryThresholdMB || 2000,
      maxRuntimeHours: parseInt(values["max-runtime"] || "") || fileConfig.processes?.maxRuntimeHours || 2,
      safeToKillPatterns,
      ignorePatterns,
    };
    const issues = await monitorProcesses(processConfig, webhookUrl, state, actions);
    allIssues = allIssues.concat(issues);
  }

  if (command === "system" || command === "all") {
    // Detect runtime for swap restart feature
    let runtime: "docker" | "podman" | undefined;
    const swapRestartDir = values["swap-restart-dir"] || fileConfig.system?.swapRestartCompose?.composeDir;
    if (swapRestartDir) {
      runtime = await detectRuntime();
    }

    const swapKillPatterns = values["swap-kill"] || fileConfig.system?.swapKillPatterns || [];

    // Validate patterns and paths
    if (swapKillPatterns.length > 0) {
      validatePatterns(swapKillPatterns, "swap-kill");
    }
    if (swapRestartDir) {
      validatePath(swapRestartDir, "swap-restart-dir");
    }

    const systemConfig: SystemConfig = {
      swapThreshold: parseInt(values["swap-threshold"] || "") || fileConfig.system?.swapThreshold || 80,
      checkDState: !values["no-dstate"] && (fileConfig.system?.checkDState !== false),
      swapKillPatterns,
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
