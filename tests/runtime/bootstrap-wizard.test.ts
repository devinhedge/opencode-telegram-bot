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

import { readFile, rm, writeFile } from "node:fs/promises";
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
    const prompts = await import("../../src/runtime/prompts.js");
    const { __setMockInputs } = prompts as typeof prompts & { __setMockInputs: (inputs: string[]) => void };
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
      "", // log location (default)
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
    const prompts = await import("../../src/runtime/prompts.js");
    const { __setMockInputs } = prompts as typeof prompts & { __setMockInputs: (inputs: string[]) => void };
    const { createSecretStore } = await import("../../src/secrets/secret-store-factory.js");
    const { runWizardAndPersist } = await import("../../src/runtime/bootstrap.js");
    const { getRuntimePaths } = await import("../../src/runtime/paths.js");

    const customStore = new FakeSecretStore("custom-backend");

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
      "", // log location (default)
    ]);

    const consoleSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runWizardAndPersist(runtimePaths);

    // Check that backend name was reported
    const output = consoleSpy.mock.calls.flat().join("");
    expect(output).toContain("custom-backend");
    consoleSpy.mockRestore();
  });

  it("wizard prompts for password when encrypted-file backend is used", async () => {
    const prompts = await import("../../src/runtime/prompts.js");
    const { __setMockInputs } = prompts as typeof prompts & { __setMockInputs: (inputs: string[]) => void };
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
      "", // log location (default)
      password, // keystore password prompt
    ]);

    await runWizardAndPersist(runtimePaths);

    // Verify secrets were written to store
    expect(await store.getSecret("telegram_bot_token")).toBe("123456:abcdef");
    expect(await store.getSecret("allowed_user_id")).toBe("123456789");
  });
});

describe("runtime/bootstrap wizard LOG_LOCATION question", () => {
  let tempHome: string;
  let stdinTtyDescriptor: PropertyDescriptor | undefined;
  let stdoutTtyDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    tempHome = await createTestHome("opencode-telegram-wizard-logloc-");
    stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", tempHome);
    setRuntimeMode("installed");
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

  async function runWizard(
    logLocationAnswers: string[],
    existingEnv?: string,
  ): Promise<{ envContent: string; output: string; prompts: string[] }> {
    const prompts = await import("../../src/runtime/prompts.js");
    const { __setMockInputs } = prompts as typeof prompts & {
      __setMockInputs: (inputs: string[]) => void;
    };
    const { createSecretStore } = await import("../../src/secrets/secret-store-factory.js");
    const { runWizardAndPersist } = await import("../../src/runtime/bootstrap.js");
    const { getRuntimePaths } = await import("../../src/runtime/paths.js");

    vi.mocked(createSecretStore).mockResolvedValue(new FakeSecretStore());
    const runtimePaths = getRuntimePaths();
    if (existingEnv !== undefined) {
      await writeFile(runtimePaths.envFilePath, existingEnv, "utf-8");
    }

    __setMockInputs([
      "en", // locale
      "123456:abcdef", // token
      "123456789", // allowed user id
      "1", // server version (v1)
      "", // api url (default)
      "opencode", // username
      "", // password (empty for v1)
      ...logLocationAnswers,
    ]);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runWizardAndPersist(runtimePaths);
      const output = writeSpy.mock.calls.flat().join("");
      const envContent = await readFile(runtimePaths.envFilePath, "utf-8");
      const askedPrompts = vi.mocked(prompts.askVisible).mock.calls.map((call) => String(call[0]));
      return { envContent, output, prompts: askedPrompts };
    } finally {
      writeSpy.mockRestore();
    }
  }

  it.each([
    ["1", "default"],
    ["2", "app"],
    ["default", "default"],
    ["app", "app"],
    ["APP", "app"],
    ["Default", "default"],
  ])("accepts %j and writes LOG_LOCATION=%s", async (answer, expected) => {
    const { envContent } = await runWizard([answer]);

    expect(envContent).toMatch(new RegExp(`^LOG_LOCATION=${expected}$`, "m"));
  });

  it("keeps the default on Enter when nothing is saved", async () => {
    const { envContent } = await runWizard([""]);

    expect(envContent).toMatch(/^LOG_LOCATION=default$/m);
  });

  it("offers the saved valid LOG_LOCATION as the default and keeps it on Enter", async () => {
    const { envContent, prompts } = await runWizard([""], "LOG_LOCATION=app\n");

    expect(envContent).toMatch(/^LOG_LOCATION=app$/m);
    const { t } = await import("../../src/i18n/index.js");
    expect(prompts).toContain(t("runtime.wizard.ask_log_location", { defaultLocation: "app" }));
  });

  it("falls back to default when the saved LOG_LOCATION is invalid", async () => {
    const { envContent, prompts } = await runWizard([""], "LOG_LOCATION=bogus\n");

    expect(envContent).toMatch(/^LOG_LOCATION=default$/m);
    expect(envContent).not.toContain("bogus");
    const { t } = await import("../../src/i18n/index.js");
    expect(prompts).toContain(t("runtime.wizard.ask_log_location", { defaultLocation: "default" }));
  });

  it("rejects invalid answers with the invalid message, then accepts a valid one", async () => {
    const { envContent, output } = await runWizard(["3", "nope", "2"]);

    const { t } = await import("../../src/i18n/index.js");
    const invalid = t("runtime.wizard.log_location_invalid", { defaultLocation: "default" });
    expect(output.split(invalid).length - 1).toBe(2);
    expect(envContent).toMatch(/^LOG_LOCATION=app$/m);
  });

  it("names the saved location as the Enter default in the invalid message", async () => {
    const { output } = await runWizard(["3", ""], "LOG_LOCATION=app\n");

    const { t } = await import("../../src/i18n/index.js");
    expect(output).toContain(t("runtime.wizard.log_location_invalid", { defaultLocation: "app" }));
  });
});
