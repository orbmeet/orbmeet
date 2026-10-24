import { queryOptions } from "@tanstack/react-query";
import { listSessions } from "@/modules/identity/server/account.functions";
import { listPasskeys } from "@/modules/identity/server/passkey.functions";
import { getLinkedAccounts } from "@/modules/identity/server/oauth-google.functions";
import { getMyStorageUsage } from "@/modules/assets/server/storage-usage.functions";
import { listPersonalAccessTokens } from "@/modules/developer-api/server/personal-access-tokens.functions";
import { queryKeys } from "@/app/query-client/query-keys";

export const sessionsListQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.sessions.all(),
    queryFn: ({ signal }) => listSessions({ signal }),
    staleTime: 30 * 1000, // 30s — security-sensitive, keep fresh
    gcTime: 1000 * 60 * 5,
  });

export const linkedAccountsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.linkedAccounts(),
    queryFn: ({ signal }) => getLinkedAccounts({ signal }),
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
  });

export const passkeysQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.passkeys(),
    queryFn: ({ signal }) => listPasskeys({ signal }),
    staleTime: 30 * 1000,
    gcTime: 1000 * 60 * 5,
  });

export const storageUsageQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.storage.usage(),
    queryFn: ({ signal }) => getMyStorageUsage({ signal }),
    staleTime: 60 * 1000,
    gcTime: 1000 * 60 * 5,
  });

export const personalAccessTokensQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.personalAccessTokens(),
    queryFn: ({ signal }) => listPersonalAccessTokens({ signal }),
    staleTime: 15 * 1000,
    gcTime: 1000 * 60 * 5,
  });
