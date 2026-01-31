import { $ } from "bun";
import type { Issue, SystemConfig, WatchdogState } from "../types";
import { getIssueKey, sendNotification } from "../utils";
import { getProcessList, killProcess } from "./processes";

// ============================================================================
// System Monitoring
// ============================================================================

export async function monitorSystem(
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
    console.log(`  \u2713 System healthy`);
  }

  return issues;
}
