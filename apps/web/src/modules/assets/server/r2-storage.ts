import "@tanstack/react-start/server-only";

export function headR2Object(env: Env, key: string): Promise<R2Object | null> {
  return env.R2_BUCKET.head(key);
}
