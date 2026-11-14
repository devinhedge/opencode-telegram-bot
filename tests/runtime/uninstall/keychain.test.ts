import { describe, expect, it, vi } from "vitest";
import { STORED_KEYCHAIN_ACCOUNTS } from "../../../src/runtime/stored-data.js";
import {
  removeKeychainAccounts,
  type KeychainRemovalStore,
} from "../../../src/runtime/uninstall/keychain.js";

type Status = "removed" | "absent" | "failed";

function createStore(available: boolean, status: (account: string) => Status) {
  const removeSecret = vi.fn(async (account: string) => status(account));
  const store: KeychainRemovalStore = {
    isAvailable: vi.fn(async () => available),
    removeSecret,
  };
  return { store, removeSecret };
}

describe("runtime/uninstall/keychain", () => {
  it("removes every inventory account once, in order, and reports each status", async () => {
    const { store, removeSecret } = createStore(true, () => "removed");

    const result = await removeKeychainAccounts(store);

    expect(removeSecret.mock.calls.map((call) => call[0])).toEqual([...STORED_KEYCHAIN_ACCOUNTS]);
    expect(result).toEqual({
      available: true,
      results: STORED_KEYCHAIN_ACCOUNTS.map((account) => ({ account, status: "removed" })),
    });
  });

  it("reports mixed statuses per account", async () => {
    const [first, ...rest] = STORED_KEYCHAIN_ACCOUNTS;
    const { store } = createStore(true, (account) => (account === first ? "failed" : "absent"));

    const result = await removeKeychainAccounts(store);

    expect(result.results[0]).toEqual({ account: first, status: "failed" });
    expect(result.results.slice(1)).toEqual(rest.map((account) => ({ account, status: "absent" })));
  });

  it("returns unavailable with no results and never calls removeSecret", async () => {
    const { store, removeSecret } = createStore(false, () => "removed");

    const result = await removeKeychainAccounts(store);

    expect(result).toEqual({ available: false, results: [] });
    expect(removeSecret).not.toHaveBeenCalled();
  });

  it("reports removed on the first run and absent on the second over a stateful store", async () => {
    const present = new Set<string>(STORED_KEYCHAIN_ACCOUNTS);
    const store: KeychainRemovalStore = {
      isAvailable: async () => true,
      removeSecret: async (account) => (present.delete(account) ? "removed" : "absent"),
    };

    const first = await removeKeychainAccounts(store);
    const second = await removeKeychainAccounts(store);

    expect(first.results.every((entry) => entry.status === "removed")).toBe(true);
    expect(second.available).toBe(true);
    expect(second.results).toEqual(
      STORED_KEYCHAIN_ACCOUNTS.map((account) => ({ account, status: "absent" })),
    );
  });

  it("reports every account failed when the keychain is available but locked", async () => {
    const { store } = createStore(true, () => "failed");

    const result = await removeKeychainAccounts(store);

    expect(result).toEqual({
      available: true,
      results: STORED_KEYCHAIN_ACCOUNTS.map((account) => ({ account, status: "failed" })),
    });
  });

  it("returns availability and no results for an empty account list", async () => {
    const { store, removeSecret } = createStore(true, () => "removed");

    const result = await removeKeychainAccounts(store, []);

    expect(result).toEqual({ available: true, results: [] });
    expect(removeSecret).not.toHaveBeenCalled();
  });

  it("honors an explicit account list", async () => {
    const { store, removeSecret } = createStore(true, () => "removed");

    const result = await removeKeychainAccounts(store, ["a", "b"]);

    expect(removeSecret.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
    expect(result.results).toEqual([
      { account: "a", status: "removed" },
      { account: "b", status: "removed" },
    ]);
  });
});
