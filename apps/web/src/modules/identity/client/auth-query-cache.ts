import type { QueryClient } from "@tanstack/react-query";

/**
 * User-scoped query keys intentionally omit user id, so a successful auth
 * identity change must drop old query data before entering protected routes.
 */
export async function resetAuthQueryCache(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.removeQueries();
}
