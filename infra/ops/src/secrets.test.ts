import { describe, expect, it } from "vitest";
import { loadInventory } from "./inventory.ts";
import {
  IMPORTED_KEYS, loadSecrets, setSecret, signingKey, transcriptionKeysSecret, validateSecrets,
  type SecretStore, type Secrets,
} from "./secrets.ts";
import { fakeSecrets, INVENTORY } from "./test-fixtures.ts";

function memoryStore(initial: Partial<Secrets> | null = null): SecretStore & { saved: number; value: Partial<Secrets> | null } {
  return {
    saved: 0,
    value: initial === null ? null : structuredClone(initial),
    async read() {
      return this.value === null ? null : structuredClone(this.value);
    },
    async write(secrets) {
      this.value = structuredClone(secrets);
      this.saved++;
    },
  };
}

const inv = loadInventory(INVENTORY);

describe("secrets", () => {
  it("are generated on the first run, except those created elsewhere", async () => {
    const store = memoryStore();
    await expect(loadSecrets(inv, store)).rejects.toThrow("pnpm ops set-secret R2_ACCESS_KEY_ID");
    for (const key of IMPORTED_KEYS) await setSecret(inv, store, key, `value-of-${key.toLowerCase()}`);
    const c = await loadSecrets(inv, store);
    expect(c.R2_BUCKET_NAME).toBe("value-of-r2_bucket_name");
    expect(Object.keys(c.nodes)).toEqual(["sg1", "my1"]);
    expect(Object.keys(c.nodes.my1.LIVEKIT_KEYS)[0]).toMatch(/^my1-/);
    expect(Object.keys(c.nodes.my1.WHITEBOARD_JWT_KEYS)[0]).toMatch(/^my1-jwt-/);
    expect(store.value).toEqual(c);
  });

  it("give a new node its own and leave the others' alone", async () => {
    const store = memoryStore(fakeSecrets(["sg1"]));
    const c = await loadSecrets(inv, store);
    expect(c.nodes.sg1).toEqual(fakeSecrets(["sg1"]).nodes.sg1);
    expect(signingKey(c, "my1")).not.toEqual(signingKey(c, "sg1"));
    expect(store.value?.nodes).toHaveProperty("my1");
  });

  it("give an existing node the secrets of new services and keep its own", async () => {
    const before = fakeSecrets();
    for (const node of Object.values(before.nodes) as unknown as Record<string, unknown>[]) {
      for (const key of ["LIVEKIT_TRANSCRIPTION_API_KEY", "LIVEKIT_TRANSCRIPTION_API_SECRET",
        "TRANSCRIPTION_INTERNAL_KEY_ID", "TRANSCRIPTION_INTERNAL_SECRET"]) delete node[key];
    }
    const c = await loadSecrets(inv, memoryStore(before));
    for (const name of ["sg1", "my1"]) {
      expect(c.nodes[name].LIVEKIT_KEYS).toEqual(before.nodes[name].LIVEKIT_KEYS);
      expect(c.nodes[name].LIVEKIT_TRANSCRIPTION_API_KEY).toMatch(new RegExp(`^${name}-transcription-`));
    }
  });

  it("leave with a node that left the inventory, and drop the shared whiteboard keys of old", async () => {
    const before = { ...fakeSecrets(["sg1", "my1", "old1"]), WHITEBOARD_JWT_SECRET: "j".repeat(40) };
    const store = memoryStore(before);
    const c = await loadSecrets(inv, store);
    expect(Object.keys(c.nodes)).toEqual(["sg1", "my1"]);
    expect(c).not.toHaveProperty("WHITEBOARD_JWT_SECRET");
    expect(store.saved).toBe(1);
  });

  it("are saved only when something was generated", async () => {
    const store = memoryStore(fakeSecrets());
    await loadSecrets(inv, store);
    expect(store.saved).toBe(0);
  });

  it("can be imported one at a time, but only those created elsewhere", async () => {
    const store = memoryStore(fakeSecrets());
    await setSecret(inv, store, "DEEPGRAM_API_KEY", "rotated-deepgram-key");
    expect((await loadSecrets(inv, store)).DEEPGRAM_API_KEY).toBe("rotated-deepgram-key");
    await setSecret(inv, store, "AXIOM_TOKEN", "xaat-token");
    expect((await loadSecrets(inv, store)).AXIOM_TOKEN).toBe("xaat-token");
    await expect(setSecret(inv, store, "REDIS_PASSWORD", "x")).rejects.toThrow("set-secret takes one of");
    await expect(setSecret(inv, store, "TRANSCRIPTION_RETIRING_KEYS", "not json")).rejects.toThrow("JSON object");
  });

  it("accept retiring transcription keys but never reuse their ids", async () => {
    const c = fakeSecrets();
    c.TRANSCRIPTION_RETIRING_KEYS = JSON.stringify({ "old-agent": "r".repeat(40) });
    validateSecrets(c);
    expect(JSON.parse(transcriptionKeysSecret(inv, c))["old-agent"]).toBe("r".repeat(40));
    c.TRANSCRIPTION_RETIRING_KEYS = JSON.stringify({ "my1-ingest": "r".repeat(40) });
    expect(() => validateSecrets(c)).toThrow("transcription key id must be unique");
  });

  it("sign with the first LiveKit key", async () => {
    const c = fakeSecrets();
    c.nodes.sg1.LIVEKIT_KEYS = { "sg1-new": "n".repeat(40), "sg1-old": "o".repeat(40) };
    expect(signingKey(validateSecrets(c), "sg1")).toEqual(["sg1-new", "n".repeat(40)]);
  });

  it("refuse a numeric LiveKit key id, which would jump to the front and sign", async () => {
    const c = fakeSecrets();
    c.nodes.sg1.LIVEKIT_KEYS = { "sg1-new": "n".repeat(40), "2024": "o".repeat(40) };
    expect(() => validateSecrets(c)).toThrow("not plain numbers");
  });

  it("fail without echoing values", async () => {
    const cases: [Secrets, string][] = [];
    let c = fakeSecrets();
    c.nodes.my1.LIVEKIT_KEYS = { "sg1-app": "k".repeat(40) };
    cases.push([c, "unique"]);
    c = fakeSecrets();
    c.nodes.sg1.LIVEKIT_KEYS = { "sg1-app": "short-secret-value" };
    cases.push([c, "LIVEKIT_KEYS.sg1-app"]);
    c = fakeSecrets();
    c.nodes.sg1.LIVEKIT_KEYS = {};
    cases.push([c, "LIVEKIT_KEYS"]);
    c = fakeSecrets();
    delete (c as Partial<Secrets>).EGRESS_R2_SECRET_ACCESS_KEY;
    cases.push([c, "EGRESS_R2_SECRET_ACCESS_KEY"]);
    c = fakeSecrets();
    c.nodes.sg1.WHITEBOARD_COMMAND_KEYS = { "sg1-command": c.nodes.sg1.WHITEBOARD_JWT_KEYS["sg1-jwt"] };
    cases.push([c, "distinct"]);
    c = fakeSecrets();
    c.nodes.my1.WHITEBOARD_CALLBACK_KEYS = { "sg1-callback": "c".repeat(40) };
    cases.push([c, "whiteboard key id must be unique"]);
    c = fakeSecrets();
    c.R2_ACCOUNT_ID = " leaked-value ";
    cases.push([c, "R2_ACCOUNT_ID"]);
    c = fakeSecrets();
    c.AXIOM_TOKEN = "xaat token";
    cases.push([c, "AXIOM_TOKEN"]);
    c = fakeSecrets();
    delete (c as Partial<Secrets>).AXIOM_TOKEN;
    cases.push([c, "pnpm ops set-secret AXIOM_TOKEN"]);
    for (const [value, message] of cases) {
      const failure = (() => {
        try {
          validateSecrets(value);
          return "";
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(failure).toContain(message);
      expect(failure).not.toMatch(/short-secret-value|leaked-value/);
    }
  });
});
