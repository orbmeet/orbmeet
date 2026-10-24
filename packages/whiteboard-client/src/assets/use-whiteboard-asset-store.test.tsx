// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWhiteboardAssetStore } from "./use-whiteboard-asset-store";

afterEach(cleanup);

describe("useWhiteboardAssetStore", () => {
  it("commits the upload before exposing its collaborative src", async () => {
    let finishCommit!: () => void;
    const commit = vi.fn(() => new Promise<void>((resolve) => {
      finishCommit = resolve;
    }));
    const rollback = vi.fn(async () => {});
    const uploadFile = vi.fn(async () => ({
      url: "/api/wb-assets/asset-1",
      commit,
      rollback,
    }));
    const { result } = renderHook(() => useWhiteboardAssetStore({ uploadFile }));

    let published = false;
    const upload = result.current!.upload(
      {} as never,
      new File(["image"], "image.png", { type: "image/png" }),
    ).then((value) => {
      published = true;
      return value;
    });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(published).toBe(false);

    finishCommit();
    await expect(upload).resolves.toEqual({ src: "/api/wb-assets/asset-1" });
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back and publishes nothing when finalization fails", async () => {
    const rollback = vi.fn(async () => {});
    const uploadFile = vi.fn(async () => ({
      url: "/api/wb-assets/asset-2",
      commit: vi.fn(async () => { throw new Error("commit failed"); }),
      rollback,
    }));
    const { result } = renderHook(() => useWhiteboardAssetStore({ uploadFile }));

    await expect(result.current!.upload(
      {} as never,
      new File(["image"], "image.png", { type: "image/png" }),
    )).rejects.toThrow("commit failed");
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("rolls back an upload that finishes after cancellation", async () => {
    const rollback = vi.fn(async () => {});
    const uploadFile = vi.fn(async () => ({
      url: "/api/wb-assets/asset-3",
      commit: vi.fn(async () => {}),
      rollback,
    }));
    const controller = new AbortController();
    controller.abort();
    const { result } = renderHook(() => useWhiteboardAssetStore({ uploadFile }));

    await expect(result.current!.upload(
      {} as never,
      new File(["image"], "image.png", { type: "image/png" }),
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(rollback).toHaveBeenCalledOnce();
  });
});
