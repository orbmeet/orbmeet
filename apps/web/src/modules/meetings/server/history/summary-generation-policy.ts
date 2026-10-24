export function isSummaryGenerationConfigured(
  env: Pick<Env, "AI_API_KEY" | "AI_MODEL">,
): boolean {
  return Boolean(env.AI_API_KEY?.trim() && env.AI_MODEL?.trim());
}
