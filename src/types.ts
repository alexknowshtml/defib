// ============================================================================
// Types
// ============================================================================

export interface ContainerConfig {
  healthUrl: string;
  composeDir: string;
  timeoutSeconds: number;
  maxResponseSeconds: number;
  backoffMinutes: number;
  containerRuntime: "docker" | "podman";
  serviceName?: string;
}

export interface ProcessConfig {
  cpuThreshold: number;        // CPU % to consider "high"
  memoryThresholdMB: number;   // Memory MB to consider "high"
  maxRuntimeHours: number;     // Hours before flagging long-running high-CPU
  safeToKillPatterns: string[];
  ignorePatterns: string[];
}

export interface SystemConfig {
  swapThreshold: number;       // Swap % to alert
  checkDState: boolean;        // Monitor D-state processes
  swapKillPatterns: string[];  // Processes to kill when swap critical
  swapRestartCompose?: {       // Compose stack to restart when swap critical
    composeDir: string;
    serviceName?: string;
  };
}

// Action modes: auto (execute immediately), ask (show guidance), deny (alert only)
export type ActionMode = "auto" | "ask" | "deny";

export interface ActionConfig {
  restartContainer: ActionMode;    // Restart unhealthy containers
  killRunaway: ActionMode;         // Kill high-CPU processes (safe patterns)
  killUnknown: ActionMode;         // Kill high-CPU processes (unknown)
  killSwapHog: ActionMode;         // Kill processes when swap critical
  restartForSwap: ActionMode;      // Restart compose when swap critical
}

// AI provider for enhanced diagnosis (optional)
export type AIProvider = "none" | "anthropic" | "openai" | "ollama";

export interface AIConfig {
  provider: AIProvider;
  apiKey?: string;          // For anthropic/openai
  model?: string;           // Model override (default: provider-specific)
  ollamaUrl?: string;       // For ollama (default: http://localhost:11434)
}

export interface Config {
  webhookUrl?: string;
  stateFile: string;
  container?: ContainerConfig;
  processes?: ProcessConfig;
  system?: SystemConfig;
  actions?: Partial<ActionConfig>;
  ai?: Partial<AIConfig>;
}

// Conservative defaults - only safe patterns auto-execute
export const DEFAULT_ACTIONS: ActionConfig = {
  restartContainer: "auto",   // Containers are designed to restart
  killRunaway: "auto",        // Only kills safe-to-kill patterns
  killUnknown: "ask",         // Needs human review
  killSwapHog: "ask",         // Needs human review
  restartForSwap: "ask",      // Needs human review
};

export interface WatchdogState {
  lastRestartTime: number | null;
  restartCount: number;
  lastCheckTime: number;
  consecutiveFailures: number;
  knownIssues: { [key: string]: number }; // issue key → first seen timestamp
}

export interface HealthResult {
  healthy: boolean;
  responseTime: number;
  error?: string;
}

export interface ProcessInfo {
  pid: string;
  cpu: number;
  memoryMB: number;
  runtimeHours: number;
  command: string;
  state?: string;
}

export interface Issue {
  type: "container" | "runaway" | "memory" | "stuck" | "swap";
  severity: "critical" | "warning" | "info";
  message: string;
  pid?: string;
  command?: string;
  autoKilled?: boolean;
}
