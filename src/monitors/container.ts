import { $ } from "bun";
import type { ContainerConfig, HealthResult, Issue, WatchdogState } from "../types";
import { sendNotification } from "../utils";

// ============================================================================
// Container Monitoring
// ============================================================================

export async function checkContainerHealth(config: ContainerConfig): Promise<HealthResult> {
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

export async function restartContainer(config: ContainerConfig): Promise<boolean> {
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

export async function monitorContainer(
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
    console.log(`  \u2713 Container healthy (${health.responseTime.toFixed(2)}s)`);
    state.restartCount = 0;
    state.consecutiveFailures = 0;
    return issues;
  }

  state.consecutiveFailures++;
  console.log(`  \u2717 Container unhealthy: ${health.error}`);

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
