import { $ } from "bun";
import type { ActionConfig, AIConfig, Issue, ProcessConfig, ProcessInfo, WatchdogState } from "../types";
import { DEFAULT_ACTIONS } from "../types";
import { getIssueKey, parseEtimeToHours, sendNotification } from "../utils";
import { DEFAULT_AI_CONFIG, getAIDiagnosis } from "../ai";
import { generateGuidance, printGuidance } from "../guidance";

// ============================================================================
// Process Monitoring
// ============================================================================

export function killProcess(pid: string, command: string): boolean {
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

export async function getProcessList(): Promise<ProcessInfo[]> {
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

export async function monitorProcesses(
  config: ProcessConfig,
  webhookUrl: string | undefined,
  state: WatchdogState,
  actions: ActionConfig = DEFAULT_ACTIONS,
  aiConfig: AIConfig = DEFAULT_AI_CONFIG
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
        const details = {
          pid: proc.pid,
          command: proc.command,
          cpu: proc.cpu,
          runtimeHours: proc.runtimeHours,
        };
        // Get AI diagnosis if configured
        let aiDiagnosis: string | null = null;
        if (aiConfig.provider !== "none") {
          aiDiagnosis = await getAIDiagnosis(aiConfig, "runaway_process", details);
        }
        const guidance = generateGuidance("runaway", details);
        printGuidance(guidance, aiDiagnosis);
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
          const memDetails = {
            pid: proc.pid,
            command: proc.command,
            memoryMB: proc.memoryMB,
            runtimeHours: proc.runtimeHours,
          };
          let aiDiagnosis: string | null = null;
          if (aiConfig.provider !== "none") {
            aiDiagnosis = await getAIDiagnosis(aiConfig, "high_memory", memDetails);
          }
          const guidance = generateGuidance("memory", memDetails);
          printGuidance(guidance, aiDiagnosis);
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
    console.log(`  \u2713 Processes healthy`);
  }

  return issues;
}
