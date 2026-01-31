// ============================================================================
// Human-Friendly Guidance (for "ask" mode)
// ============================================================================

export interface Guidance {
  title: string;
  problem: string;
  why: string;
  recommendation: string;
  fixCommand: string;
  investigateCommands: string[];
  dismissCommand: string;
}

export function generateGuidance(
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

export function printGuidance(guidance: Guidance, aiDiagnosis?: string | null): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`\u{1F534} ${guidance.title}`);
  console.log(`${"=".repeat(60)}\n`);

  console.log(`${guidance.problem}\n`);

  // AI-enhanced diagnosis replaces the generic "why" and "recommendation"
  if (aiDiagnosis) {
    console.log(`AI DIAGNOSIS:`);
    console.log(`${aiDiagnosis}\n`);
  } else {
    console.log(`WHY THIS IS A PROBLEM:`);
    console.log(`${guidance.why}\n`);

    console.log(`RECOMMENDED FIX:`);
    console.log(`${guidance.recommendation}\n`);
  }

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
