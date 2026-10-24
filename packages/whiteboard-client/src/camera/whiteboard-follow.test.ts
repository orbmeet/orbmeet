import { describe, expect, it } from "vitest";
import { isPresenceOf, selectWhiteboardFollowState } from "./whiteboard-follow";

const base = {
  isPresenter: false,
  myUserId: "me",
  presenterId: "maya",
  presenterName: "Maya",
  following: true,
  follow: () => {},
  stopFollowing: () => {},
};

describe("selectWhiteboardFollowState", () => {
  it("names the presenter a follower is being carried along by", () => {
    expect(selectWhiteboardFollowState(base)).toMatchObject({ presenterName: "Maya", following: true });
  });

  it("says nothing to the presenter, or about your own navigation", () => {
    expect(selectWhiteboardFollowState({ ...base, isPresenter: true })).toBeNull();
    expect(selectWhiteboardFollowState({ ...base, presenterId: "me" })).toBeNull();
  });

  it("says nothing until there is a presenter it can name", () => {
    expect(selectWhiteboardFollowState({ ...base, presenterId: null })).toBeNull();
    expect(selectWhiteboardFollowState({ ...base, presenterName: null })).toBeNull();
    expect(selectWhiteboardFollowState({ ...base, presenterName: "   " })).toBeNull();
  });

  it("carries the follower's choice through", () => {
    expect(selectWhiteboardFollowState({ ...base, following: false })?.following).toBe(false);
  });
});

describe("isPresenceOf", () => {
  it("matches tldraw's record-id form of a user id as well as the bare id", () => {
    expect(isPresenceOf("user:host_connection_1", "host_connection_1")).toBe(true);
    expect(isPresenceOf("host_connection_1", "host_connection_1")).toBe(true);
  });

  it("does not match another user, or a prefix of one", () => {
    expect(isPresenceOf("user:host_connection_10", "host_connection_1")).toBe(false);
    expect(isPresenceOf("user:guest", "host")).toBe(false);
  });
});
