import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { askVisible, askVisibleOrEof } from "../../src/runtime/prompts.js";

class FakeInterface extends EventEmitter {
  question = vi.fn<(query: string) => Promise<string>>();
  close = vi.fn(() => {
    this.emit("close");
  });
}

const state = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("node:readline/promises", () => ({
  createInterface: () => state.current,
}));

describe("runtime/prompts", () => {
  let rl: FakeInterface;

  beforeEach(() => {
    rl = new FakeInterface();
    state.current = rl;
  });

  it("askVisible returns the trimmed answer and closes the interface", async () => {
    rl.question.mockResolvedValue("  app \n");

    await expect(askVisible("q> ")).resolves.toBe("app");
    expect(rl.question).toHaveBeenCalledWith("q> ");
    expect(rl.close).toHaveBeenCalled();
  });

  it("askVisibleOrEof returns the trimmed answer and closes the interface", async () => {
    rl.question.mockResolvedValue(" default ");

    await expect(askVisibleOrEof("q> ")).resolves.toBe("default");
    expect(rl.close).toHaveBeenCalled();
  });

  it("askVisibleOrEof returns null when input ends before an answer", async () => {
    rl.question.mockImplementation(() => {
      queueMicrotask(() => rl.emit("close"));
      return new Promise<string>(() => {});
    });

    await expect(askVisibleOrEof("q> ")).resolves.toBeNull();
  });

  it("askVisibleOrEof calls the interrupt handler on Ctrl+C and closes the interface", async () => {
    rl.question.mockImplementation(() => {
      queueMicrotask(() => rl.emit("SIGINT"));
      return new Promise<string>(() => {});
    });
    const onInterrupt = vi.fn();

    await expect(askVisibleOrEof("q> ", onInterrupt)).resolves.toBeNull();

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(rl.close).toHaveBeenCalled();
  });

  it("askVisibleOrEof does not call the interrupt handler on plain end of input", async () => {
    rl.question.mockImplementation(() => {
      queueMicrotask(() => rl.emit("close"));
      return new Promise<string>(() => {});
    });
    const onInterrupt = vi.fn();

    await expect(askVisibleOrEof("q> ", onInterrupt)).resolves.toBeNull();

    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("askVisibleOrEof re-raises SIGINT on the process by default", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    rl.question.mockImplementation(() => {
      queueMicrotask(() => rl.emit("SIGINT"));
      return new Promise<string>(() => {});
    });

    try {
      await askVisibleOrEof("q> ");
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("askVisibleOrEof returns null when the question rejects", async () => {
    rl.question.mockRejectedValue(new Error("closed"));

    await expect(askVisibleOrEof("q> ")).resolves.toBeNull();
  });
});
