import { describe, expect, it, vi } from "vitest";

vi.mock("@napi-rs/keyring", () => {
  throw new Error("native binding unavailable");
});

describe("runtime/stored-data isolation", () => {
  it("imports without loading the native keyring binding", async () => {
    vi.resetModules();

    const inventory = await import("../../src/runtime/stored-data.js");

    expect(inventory.KEYCHAIN_SERVICE).toBe("opencode-telegram-bot");
  });
});
