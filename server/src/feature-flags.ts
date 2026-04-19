// Fork-patch feature flags. Interim surface until upstream Phase 3 of the
// memory-service-surface-api lands (https://github.com/paperclipai/paperclip/issues/3960).

function readBooleanEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function isAgentMemoryTabEnabled(): boolean {
  return readBooleanEnv("PAPERCLIP_FEATURE_AGENT_MEMORY_TAB");
}
