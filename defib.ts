#!/usr/bin/env bun
/**
 * defib - System Defibrillator
 *
 * Monitors system health and auto-recovers from common failure modes:
 * - Container health (HTTP endpoints) -> auto-restart
 * - Runaway processes (high CPU/memory) -> auto-kill
 * - System health (swap pressure, stuck processes) -> alert
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

import { parseArgs } from "util";
import type { ActionConfig, AIConfig, AIProvider, ContainerConfig, Issue, ProcessConfig, SystemConfig } from "./src/types";
import { DEFAULT_ACTIONS } from "./src/types";
import { detectRuntime, getSecureStateDir, loadState, saveState, validatePath, validatePatterns } from "./src/utils";
import { monitorContainer } from "./src/monitors/container";
import { monitorProcesses } from "./src/monitors/processes";
import { monitorSystem } from "./src/monitors/system";

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

AI-Enhanced Diagnosis (optional, for "ask" mode):
  --ai <provider>        AI provider: anthropic, openai, ollama, none (default: none)
  --ai-key <key>         API key for anthropic/openai (or set DEFIB_AI_API_KEY)
  --ai-model <model>     Model override (default: provider-specific)

  Default models:
    anthropic: claude-haiku-4-20250414
    openai:    gpt-4o-mini
    ollama:    llama3.1:8b

Global Options:
  --webhook <url>        Discord/Slack webhook for notifications
  --config <file>        Load config from JSON file
  --state-file <path>    State file location (default: ~/.local/state/defib/state.json)
  --help                 Show this help

Environment Variables:
  DEFIB_WEBHOOK_URL, DEFIB_HEALTH_URL, DEFIB_COMPOSE_DIR, DEFIB_AI_API_KEY
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
      // AI
      ai: { type: "string" },
      "ai-key": { type: "string" },
      "ai-model": { type: "string" },
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

  // Build AI config from CLI > env > file config > default
  const aiProvider = (values.ai || fileConfig.ai?.provider || "none") as AIProvider;
  const aiConfig: AIConfig = {
    provider: aiProvider,
    apiKey: values["ai-key"] || process.env.DEFIB_AI_API_KEY || fileConfig.ai?.apiKey,
    model: values["ai-model"] || fileConfig.ai?.model,
    ollamaUrl: fileConfig.ai?.ollamaUrl,
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
    const issues = await monitorProcesses(processConfig, webhookUrl, state, actions, aiConfig);
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
