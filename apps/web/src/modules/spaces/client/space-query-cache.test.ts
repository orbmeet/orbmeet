import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "@/app/query-client/query-keys";
import { evictSpaceQueryCache, primeSpaceDetailCache } from "./space-query-cache";

describe("evictSpaceQueryCache", () => {
  it("removes all membership-scoped data and preserves other Spaces", async () => {
    const queryClient = new QueryClient();
    const removedSpaceId = "spc_removed";
    const removedSpaceSlug = "removed-space";
    const retainedSpaceId = "spc_retained";

    queryClient.setQueryData(queryKeys.spaces.bySlug(removedSpaceSlug), {
      spaceId: removedSpaceId,
    });
    queryClient.setQueryData(queryKeys.spaces.detail(removedSpaceId), { id: removedSpaceId });
    queryClient.setQueryData(queryKeys.spaces.members(removedSpaceId), { pages: [] });
    queryClient.setQueryData(queryKeys.spaces.meetings(removedSpaceId), { pages: [] });
    queryClient.setQueryData(queryKeys.files.bySpace(removedSpaceId), { pages: [] });
    queryClient.setQueryData(queryKeys.spaces.detail(retainedSpaceId), { id: retainedSpaceId });

    await evictSpaceQueryCache(queryClient, removedSpaceId, removedSpaceSlug);

    expect(queryClient.getQueryData(queryKeys.spaces.bySlug(removedSpaceSlug))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.spaces.detail(removedSpaceId))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.spaces.members(removedSpaceId))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.spaces.meetings(removedSpaceId))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.files.bySpace(removedSpaceId))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.spaces.detail(retainedSpaceId))).toEqual({
      id: retainedSpaceId,
    });
  });
});

describe("evictSpaceQueryCache across id-keyed caches", () => {
  it("drops the Space's Whiteboards and Meeting records, with their access, and keeps other Spaces'", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.whiteboards.detail("wb_gone"), { id: "wb_gone", spaceId: "spc_removed" });
    queryClient.setQueryData(queryKeys.whiteboards.standaloneAccess("wb_gone"), { token: "t" });
    queryClient.setQueryData(queryKeys.whiteboards.detail("wb_kept"), { id: "wb_kept", spaceId: "spc_retained" });
    queryClient.setQueryData(queryKeys.whiteboards.standaloneAccess("wb_kept"), { token: "t" });
    queryClient.setQueryData(queryKeys.meetings.summary("m_gone"), { meeting: { spaceId: "spc_removed" } });
    queryClient.setQueryData(queryKeys.meetings.transcripts("m_gone"), { pages: [] });
    queryClient.setQueryData(queryKeys.meetings.summary("m_kept"), { meeting: { spaceId: "spc_retained" } });
    queryClient.setQueryData(queryKeys.meetings.list({ status: "ended" }), { pages: [] });

    await evictSpaceQueryCache(queryClient, "spc_removed");

    expect(queryClient.getQueryData(queryKeys.whiteboards.detail("wb_gone"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.whiteboards.standaloneAccess("wb_gone"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.meetings.summary("m_gone"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.meetings.transcripts("m_gone"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.whiteboards.standaloneAccess("wb_kept"))).toEqual({ token: "t" });
    expect(queryClient.getQueryData(queryKeys.meetings.summary("m_kept"))).toBeDefined();
    expect(queryClient.getQueryState(queryKeys.meetings.list({ status: "ended" }))?.isInvalidated).toBe(true);
  });
});

describe("spaces key shape", () => {
  // Regression guard: `all()` used to be the bare ["spaces"] prefix, so
  // `invalidateQueries({ queryKey: spaces.all() })` after deleting or leaving a
  // space refetched the detail/audit queries of that very space. Those refetches
  // throw FORBIDDEN/NOT_FOUND, retry is disabled for both, and useSuspenseQuery
  // rethrows — the user landed on the error boundary instead of /spaces.
  it("keeps the viewer's list disjoint from every per-space branch", () => {
    const listKey: readonly unknown[] = queryKeys.spaces.all();
    const spaceId = "spc_1";
    const perSpaceKeys: readonly (readonly unknown[])[] = [
      queryKeys.spaces.scope(spaceId),
      queryKeys.spaces.detail(spaceId),
      queryKeys.spaces.members(spaceId),
      queryKeys.spaces.meetings(spaceId),
      queryKeys.spaces.whiteboards(spaceId),
      queryKeys.spaces.audit(spaceId),
      queryKeys.spaces.defaultMeetingLink(spaceId),
      queryKeys.spaces.invite(spaceId),
      queryKeys.spaces.bySlug("a-slug"),
    ];

    for (const key of perSpaceKeys) {
      expect(key.slice(0, listKey.length)).not.toEqual(listKey);
    }
  });

  it("keeps scope() a prefix of every membership-gated branch so eviction is total", () => {
    const spaceId = "spc_1";
    const scopeKey: readonly unknown[] = queryKeys.spaces.scope(spaceId);
    const gated: readonly (readonly unknown[])[] = [
      queryKeys.spaces.detail(spaceId),
      queryKeys.spaces.members(spaceId),
      queryKeys.spaces.meetings(spaceId),
      queryKeys.spaces.whiteboards(spaceId),
      queryKeys.spaces.audit(spaceId),
      queryKeys.spaces.defaultMeetingLink(spaceId),
      queryKeys.spaces.invite(spaceId),
    ];

    for (const key of gated) {
      expect(key.slice(0, scopeKey.length)).toEqual(scopeKey);
    }
  });
});

describe("primeSpaceDetailCache", () => {
  const spaceId = "spc_primed";
  const detailPayload = { space: { id: spaceId, name: "Primed" }, memberCount: 3 };

  it("fills an empty detail entry and stamps the slug fetch time", () => {
    const queryClient = new QueryClient();
    const fetchedAt = Date.now() - 60_000;

    primeSpaceDetailCache(queryClient, detailPayload, fetchedAt);

    const detailKey = queryKeys.spaces.detail(spaceId);
    expect(queryClient.getQueryData(detailKey)).toEqual(detailPayload);
    expect(queryClient.getQueryState(detailKey)?.dataUpdatedAt).toBe(fetchedAt);
  });

  it("does not overwrite an existing detail entry", () => {
    const queryClient = new QueryClient();
    const existing = { space: { id: spaceId, name: "Fresher" }, memberCount: 4 };
    queryClient.setQueryData(queryKeys.spaces.detail(spaceId), existing);

    primeSpaceDetailCache(queryClient, detailPayload, Date.now());

    expect(queryClient.getQueryData(queryKeys.spaces.detail(spaceId))).toEqual(existing);
  });
});
