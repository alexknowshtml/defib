import type { AIConfig } from "./types";

// ============================================================================
// AI-Enhanced Diagnosis (optional)
// ============================================================================

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: "none",
};

export const AI_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-20250414",
  openai: "gpt-4o-mini",
  ollama: "llama3.1:8b",
};

export function buildDiagnosisPrompt(
  type: string,
  details: {
    pid?: string;
    command?: string;
    cpu?: number;
    memoryMB?: number;
    runtimeHours?: number;
    swapPercent?: number;
    healthUrl?: string;
  }
): string {
  return `You are a Linux system administrator diagnosing a production issue. Be concise and specific.

Issue type: ${type}
${details.pid ? `PID: ${details.pid}` : ""}
${details.command ? `Process: ${details.command}` : ""}
${details.cpu ? `CPU usage: ${details.cpu.toFixed(1)}%` : ""}
${details.memoryMB ? `Memory: ${details.memoryMB.toFixed(0)}MB` : ""}
${details.runtimeHours ? `Runtime: ${details.runtimeHours.toFixed(1)} hours` : ""}
${details.swapPercent ? `Swap usage: ${details.swapPercent.toFixed(1)}%` : ""}
${details.healthUrl ? `Health URL: ${details.healthUrl}` : ""}

Based on the process name and resource usage pattern, provide:
1. DIAGNOSIS: What's likely happening (1-2 sentences)
2. ROOT CAUSE: Most probable root cause based on the process type
3. FIX: The specific command(s) to run, and why
4. PREVENT: How to prevent recurrence (1 sentence)

Keep your total response under 200 words.`;
}

export async function getAIDiagnosis(
  aiConfig: AIConfig,
  type: string,
  details: Parameters<typeof buildDiagnosisPrompt>[1]
): Promise<string | null> {
  const prompt = buildDiagnosisPrompt(type, details);

  try {
    switch (aiConfig.provider) {
      case "anthropic": {
        if (!aiConfig.apiKey) {
          console.error("  AI: Anthropic API key required (set ai.apiKey or DEFIB_AI_API_KEY)");
          return null;
        }
        const model = aiConfig.model || AI_MODELS.anthropic;
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": aiConfig.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 500,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!response.ok) {
          console.error(`  AI: Anthropic API error: ${response.status}`);
          return null;
        }
        const data = await response.json() as any;
        return data.content?.[0]?.text || null;
      }

      case "openai": {
        if (!aiConfig.apiKey) {
          console.error("  AI: OpenAI API key required (set ai.apiKey or DEFIB_AI_API_KEY)");
          return null;
        }
        const model = aiConfig.model || AI_MODELS.openai;
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${aiConfig.apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 500,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!response.ok) {
          console.error(`  AI: OpenAI API error: ${response.status}`);
          return null;
        }
        const data = await response.json() as any;
        return data.choices?.[0]?.message?.content || null;
      }

      case "ollama": {
        const baseUrl = aiConfig.ollamaUrl || "http://localhost:11434";
        const model = aiConfig.model || AI_MODELS.ollama;
        const response = await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
          }),
        });
        if (!response.ok) {
          console.error(`  AI: Ollama error: ${response.status} (is Ollama running?)`);
          return null;
        }
        const data = await response.json() as any;
        return data.response || null;
      }

      default:
        return null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`  AI: Diagnosis failed: ${msg}`);
    return null;
  }
}
