import { $ } from "bun";
import type { Issue, WatchdogState } from "./types";

// ============================================================================
// Utilities
// ============================================================================

export async function detectRuntime(): Promise<"docker" | "podman"> {
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

export function parseEtimeToHours(etime: string): number {
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

export function getIssueKey(issue: Issue): string {
  if (issue.type === "swap") return "swap_critical";
  if (issue.pid) return `${issue.type}:${issue.pid}`;
  return `${issue.type}:${issue.message}`;
}

// ============================================================================
// Security Validations
// ============================================================================

export function validatePatterns(patterns: string[], name: string): void {
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

export function validatePath(path: string, name: string): void {
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

export function getSecureStateDir(): string {
  // Use XDG_STATE_HOME or fall back to ~/.local/state
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState) return `${xdgState}/defib`;
  const home = process.env.HOME;
  if (home) return `${home}/.local/state/defib`;
  // Last resort: /tmp with user-specific dir
  return `/tmp/defib-${process.getuid?.() || 'unknown'}`;
}

// ============================================================================
// State Management
// ============================================================================

export async function loadState(stateFile: string): Promise<WatchdogState> {
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

export async function saveState(stateFile: string, state: WatchdogState): Promise<void> {
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

export async function sendNotification(
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
      title: isError ? `\u{1F534} ${title}` : `\u{1F7E1} ${title}`,
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
