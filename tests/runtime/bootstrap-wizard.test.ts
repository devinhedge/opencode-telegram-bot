// Mock prompts module for wizard tests - must be before any imports
vi.mock("../../src/runtime/prompts.js", () => {
  let mockInputs: string[] = [];
  let inputIndex = 0;

  return {
    askVisible: vi.fn((_question: string) => {
      const answer = mockInputs[inputIndex++];
      return Promise.resolve(answer);
    }),
    askHidden: vi.fn((_question: string) => {
      const answer = mockInputs[inputIndex++];
      return Promise.resolve(answer);
    }),
    __setMockInputs: (inputs: string[]) => {
      mockInputs = inputs;
      inputIndex = 0;
    },
  };
});

// Mock secret-store-factory
vi.mock("../../src/secrets/secret-store-factory.js");

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHome } from "../helpers/test-environment.js";
import { setRuntimeMode } from "../../src/runtime/mode.js";
import { FakeSecretStore } from "../../src/secrets/fake-secret-store.js";
import { EncryptedFileSecretStore } from "../../src/secrets/encrypted-file-secret-store.js";

describe("runtime/bootstrap wizard with SecretStore", () => {
  let tempHome: string;
  let stdinTtyDescriptor: PropertyDescriptor | undefined;
  let stdoutTtyDescriptor: PropertyDescriptor | undefined;
  let fakeStore: FakeSecretStore;

  beforeEach(async () => {
    tempHome = await createTestHome("opencode-telegram-wizard-");
    stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", tempHome);
    setRuntimeMode("installed");

    fakeStore = new FakeSecretStore();
    vi.resetModules();
  });

  afterEach(async () => {
    if (stdinTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    if (stdoutTtyDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutTtyDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    vi.unstubAllEnvs();
    delete process.env.OPENCODE_TELEGRAM_RUNTIME_MODE;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("wizard writes secrets to SecretStore and non-secrets to .env", async () => {
    const { __setMockInputs } = await import("../../src/runtime/prompts.js");
    const { createSecretStore } = await import("../../src/secrets/secret-store-factory.js");
    const { runWizardAndPersist } = await import("../../src/runtime/bootstrap.js");
    const { getRuntimePaths } = await import("../../src/runtime/paths.js");

    // Mock the secret store factory to return our fake store
    vi.mocked(createSecretStore).mockResolvedValue(fakeStore);

    const runtimePaths = getRuntimePaths();

    // Simulate wizard input
    __setMockInputs([
      "en", // locale
      "123456:abcdef", // token
      "123456789", // allowed user id
      "1", // server version (v1)
      "", // api url (default)
      "opencode", // username
      "", // password (empty for v1)
    ]);

    await runWizardAndPersist(runtimePaths);

    // Verify secrets were written to store
    expect(await fakeStore.getSecret("telegram_bot_token")).toBe("123456:abcdef");
    expect(await fakeStore.getSecret("allowed_user_id")).toBe("123456789");

    // Verify non-secrets were written to .env
    const envContent = await readFile(runtimePaths.envFilePath, "utf-8");
    expect(envContent).toContain("BOT_LOCALE=en");
    expect(envContent).toContain("OPENCODE_SERVER_VERSION=v1");
    expect(envContent).toContain("OPENCODE_SERVER_USERNAME=opencode");
    expect(envContent).toContain("OPENCODE_MODEL_PROVIDER=opencode");
    expect(envContent).toContain("OPENCODE_MODEL_ID=big-pickle");

    // Verify secret VALUES are NOT in .env (template placeholders may remain as comments)
    expect(envContent).not.toContain("TELEGRAM_BOT_TOKEN=123456:abcdef");
    expect(envContent).not.toContain("TELEGRAM_ALLOWED_USER_ID=123456789");
    // OPENCODE_SERVER_PASSWORD is empty for v1, so just check it's not set to a value
    expect(envContent).not.toMatch(/OPENCODE_SERVER_PASSWORD=.+/);
  });

  it("wizard reports active backend name", async () => {
    const { __setMockInputs } = await import("../../src/runtime/prompts.js");
    const { createSecretStore } = await import("../../src/secrets/secret-store-factory.js");
    const { runWizardAndPersist } = await import("../../src/runtime/bootstrap.js");
    const { getRuntimePaths } = await import("../../src/runtime/paths.js");

    const customStore = new FakeSecretStore();
    customStore.name = "custom-backend";

    vi.mocked(createSecretStore).mockResolvedValue(customStore);

    const runtimePaths = getRuntimePaths();

    __setMockInputs([
      "en", // locale
      "123456:abcdef", // token
      "123456789", // allowed user id
      "1", // server version (v1)
      "", // api url (default)
      "opencode", // username
      "", // password (empty for v1)
    ]);

    const consoleSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runWizardAndPersist(runtimePaths);

    // Check that backend name was reported
    const output = consoleSpy.mock.calls.flat().join("");
    expect(output).toContain("custom-backend");
    consoleSpy.mockRestore();
  });

  it("wizard prompts for password when encrypted-file backend is used", async () => {
    const { __setMockInputs } = await import("../../src/runtime/prompts.js");
    const { createSecretStore } = await import("../../src/secrets/secret-store-factory.js");
    const { runWizardAndPersist } = await import("../../src/runtime/bootstrap.js");
    const { getRuntimePaths } = await import("../../src/runtime/paths.js");

    const store = new EncryptedFileSecretStore(path.join(tempHome, "secrets.enc"));
    const password = "test-password-123";
    await store.unlock(password);

    vi.mocked(createSecretStore).mockResolvedValue(store);

    const runtimePaths = getRuntimePaths();

    __setMockInputs([
      "en", // locale
      "123456:abcdef", // token
      "123456789", // allowed user id
      "1", // server version (v1)
      "", // api url (default)
      "opencode", // username
      "", // password (empty for v1)
      password, // keystore password prompt
    ]);

    await runWizardAndPersist(runtimePaths);

    // Verify secrets were written to store
    expect(await store.getSecret("telegram_bot_token")).toBe("123456:abcdef");
    expect(await store.getSecret("allowed_user_id")).toBe("123456789");
  });
});