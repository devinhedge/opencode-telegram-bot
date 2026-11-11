import { describe, expect, it } from "vitest";
import {
  getServiceLogsDirFromEnv,
  isServiceChildProcess,
} from "../../../src/runtime/service/env.js";

describe("runtime/service/env", () => {
  it("reads the child flag from an injected env", () => {
    expect(isServiceChildProcess({ OPENCODE_TELEGRAM_SERVICE_CHILD: "1" })).toBe(true);
    expect(isServiceChildProcess({ OPENCODE_TELEGRAM_SERVICE_CHILD: "0" })).toBe(false);
    expect(isServiceChildProcess({})).toBe(false);
  });

  it("defaults the child flag to process.env", () => {
    const previous = process.env.OPENCODE_TELEGRAM_SERVICE_CHILD;
    try {
      process.env.OPENCODE_TELEGRAM_SERVICE_CHILD = "1";
      expect(isServiceChildProcess()).toBe(true);
      delete process.env.OPENCODE_TELEGRAM_SERVICE_CHILD;
      expect(isServiceChildProcess()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_TELEGRAM_SERVICE_CHILD;
      } else {
        process.env.OPENCODE_TELEGRAM_SERVICE_CHILD = previous;
      }
    }
  });

  it("returns the service logs dir, or null when unset or blank", () => {
    expect(getServiceLogsDirFromEnv({ OPENCODE_TELEGRAM_SERVICE_LOGS_DIR: "/l" })).toBe("/l");
    expect(getServiceLogsDirFromEnv({ OPENCODE_TELEGRAM_SERVICE_LOGS_DIR: "  " })).toBeNull();
    expect(getServiceLogsDirFromEnv({})).toBeNull();
  });
});
