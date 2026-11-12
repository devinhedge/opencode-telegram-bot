import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findBotProcesses,
  parseProcessList,
  type RawProcess,
  type ScanDeps,
} from "../../../src/runtime/uninstall/processes.js";

const ROOT = path.resolve("/opt/checkout");
const GLOBAL_ROOT = path.resolve("/usr/lib/node_modules/@grinev/opencode-telegram-bot");
const CLI = path.join(ROOT, "dist", "cli.js");
const INDEX = path.join(ROOT, "dist", "index.js");
const GLOBAL_CLI = path.join(GLOBAL_ROOT, "dist", "cli.js");
const OTHER_CHECKOUT_INDEX = path.resolve("/home/other/checkout/dist/index.js");
const STARTED = "Mon Nov 12 10:00:00 2026";

function proc(pid: number, ppid: number, args: string, user = "dev"): RawProcess {
  return { pid, ppid, user, startedAt: STARTED, args };
}

function makeDeps(processes: RawProcess[], overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    listProcesses: async () => processes,
    realpath: async (p) => p,
    cwdOf: async () => null,
    entryPoints: [CLI, INDEX, GLOBAL_CLI],
    ownPid: 9000,
    excludePids: [],
    ...overrides,
  };
}

describe("parseProcessList", () => {
  it("parses a macOS-style sample with a command line that has spaces", () => {
    const output = [
      "    1     0 root             Sat Nov  1 08:00:01 2026 /sbin/launchd",
      "  501   400 dev              Mon Nov 12 10:00:00 2026 node /Users/dev/My Projects/bot/dist/index.js",
    ].join("\n");

    expect(parseProcessList(output)).toEqual([
      {
        pid: 1,
        ppid: 0,
        user: "root",
        startedAt: "Sat Nov  1 08:00:01 2026",
        args: "/sbin/launchd",
      },
      {
        pid: 501,
        ppid: 400,
        user: "dev",
        startedAt: "Mon Nov 12 10:00:00 2026",
        args: "node /Users/dev/My Projects/bot/dist/index.js",
      },
    ]);
  });

  it("parses a Linux-style sample", () => {
    const output = [
      "    1     0 root     Wed Nov 11 07:12:44 2026 /sbin/init splash",
      " 2210  2100 devin    Thu Nov 12 09:05:09 2026 node /srv/bot/dist/cli.js start",
    ].join("\n");

    expect(parseProcessList(output)).toEqual([
      {
        pid: 1,
        ppid: 0,
        user: "root",
        startedAt: "Wed Nov 11 07:12:44 2026",
        args: "/sbin/init splash",
      },
      {
        pid: 2210,
        ppid: 2100,
        user: "devin",
        startedAt: "Thu Nov 12 09:05:09 2026",
        args: "node /srv/bot/dist/cli.js start",
      },
    ]);
  });

  it("ignores empty and malformed lines", () => {
    const output = [
      "",
      "   ",
      "not a process line",
      "abc 1 root Mon Nov 12 10:00:00 2026 node x.js",
      "  42     1 dev     Mon Nov 12 10:00:00 2026 node ok.js",
      "  43     1 dev     Mon Nov 12 10:00:00 2026",
    ].join("\n");

    expect(parseProcessList(output)).toEqual([proc(42, 1, "node ok.js")]);
  });
});

describe("findBotProcesses", () => {
  it("lists a node process that runs the dist/index.js entry point", async () => {
    const result = await findBotProcesses(makeDeps([proc(100, 1, `node ${INDEX}`)]));

    expect(result).toEqual([
      { pid: 100, user: "dev", startedAt: STARTED, commandLine: `node ${INDEX}`, verified: true },
    ]);
  });

  it("lists dist/cli.js only with the start subcommand", async () => {
    const result = await findBotProcesses(
      makeDeps([
        proc(100, 1, `node ${CLI} start`),
        proc(101, 1, `node ${CLI} start --daemon`),
        proc(102, 1, `node ${CLI} uninstall`),
        proc(103, 1, `node ${CLI} config`),
        proc(104, 1, `node ${CLI} status`),
        proc(105, 1, `node ${CLI} stop`),
        proc(106, 1, `node ${CLI} --help`),
        proc(107, 1, `node ${CLI}`),
      ]),
    );

    expect(result.map((p) => p.pid)).toEqual([100, 101]);
  });

  it("accepts nodejs and a path-qualified node as argv0", async () => {
    const result = await findBotProcesses(
      makeDeps([
        proc(100, 1, `nodejs ${INDEX}`),
        proc(101, 1, `/usr/local/bin/node ${INDEX}`),
        proc(102, 1, `node-wrapper ${INDEX}`),
      ]),
    );

    expect(result.map((p) => p.pid)).toEqual([100, 101]);
  });

  it("skips node options before the script", async () => {
    const result = await findBotProcesses(
      makeDeps([proc(100, 1, `node --enable-source-maps --no-warnings ${INDEX}`)]),
    );

    expect(result.map((p) => p.pid)).toEqual([100]);
  });

  it("matches a launcher symlink through its realpath", async () => {
    const launcher = path.resolve("/usr/local/bin/opencode-telegram");
    const result = await findBotProcesses(
      makeDeps([proc(100, 1, `node ${launcher} start`)], {
        realpath: async (p) => (p === launcher ? GLOBAL_CLI : p),
      }),
    );

    expect(result.map((p) => p.pid)).toEqual([100]);
  });

  it("does not match a launcher symlink to a different file", async () => {
    const launcher = path.resolve("/usr/local/bin/other-tool");
    const result = await findBotProcesses(
      makeDeps([proc(100, 1, `node ${launcher} start`)], {
        realpath: async (p) => (p === launcher ? OTHER_CHECKOUT_INDEX : p),
      }),
    );

    expect(result).toEqual([]);
  });

  it("resolves a relative script against the process cwd", async () => {
    const result = await findBotProcesses(
      makeDeps([proc(100, 1, "node dist/index.js"), proc(101, 1, "node dist/index.js")], {
        cwdOf: async (pid) => (pid === 100 ? ROOT : path.resolve("/home/other/checkout")),
      }),
    );

    expect(result).toEqual([
      {
        pid: 100,
        user: "dev",
        startedAt: STARTED,
        commandLine: "node dist/index.js",
        verified: true,
      },
    ]);
  });

  it("resolves ./dist/cli.js with start against the process cwd", async () => {
    const result = await findBotProcesses(
      makeDeps([proc(100, 1, "node ./dist/cli.js start")], { cwdOf: async () => ROOT }),
    );

    expect(result.map((p) => p.pid)).toEqual([100]);
  });

  it("lists a relative script with an unknown cwd as unverified", async () => {
    const result = await findBotProcesses(makeDeps([proc(100, 1, "node dist/index.js")]));

    expect(result).toEqual([
      {
        pid: 100,
        user: "dev",
        startedAt: STARTED,
        commandLine: "node dist/index.js",
        verified: false,
      },
    ]);
  });

  it("does not list an unknown-cwd relative script that is not an entry point suffix", async () => {
    const result = await findBotProcesses(
      makeDeps([
        proc(100, 1, "node src/index.js"),
        proc(101, 1, "node ../dist/index.js"),
        proc(102, 1, "node dist/cli.js uninstall"),
      ]),
    );

    expect(result).toEqual([]);
  });

  it("lists a dangling symlink script by its lexical path", async () => {
    const result = await findBotProcesses(
      makeDeps([proc(100, 1, `node ${INDEX}`)], {
        realpath: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    );

    expect(result.map((p) => p.pid)).toEqual([100]);
  });

  it("does not match a bot run from another checkout", async () => {
    const result = await findBotProcesses(makeDeps([proc(100, 1, `node ${OTHER_CHECKOUT_INDEX}`)]));

    expect(result).toEqual([]);
  });

  it("does not match an editor or grep that mentions the script path", async () => {
    const result = await findBotProcesses(
      makeDeps([
        proc(100, 1, `vim ${INDEX}`),
        proc(101, 1, "grep opencode-telegram"),
        proc(102, 1, `code ${CLI} start`),
        proc(103, 1, `tail -f ${INDEX}`),
      ]),
    );

    expect(result).toEqual([]);
  });

  it("never lists the own pid or its ancestor chain", async () => {
    const processes = [
      proc(9000, 8000, `node ${CLI} start`),
      proc(8000, 7000, `node ${CLI} start`),
      proc(7000, 6000, `make uninstall # opencode-telegram uninstall`),
      proc(6000, 1, `node ${INDEX}`),
      proc(5000, 1, `node ${INDEX}`),
    ];

    const result = await findBotProcesses(makeDeps(processes));

    expect(result.map((p) => p.pid)).toEqual([5000]);
  });

  it("excludes the ancestor chain even when an ancestor matches the entry point", async () => {
    const processes = [
      proc(9000, 8500, `node ${CLI} uninstall`),
      proc(8500, 8400, "npm exec opencode-telegram uninstall"),
      proc(8400, 8300, `node ${INDEX}`),
      proc(8300, 1, "-zsh"),
    ];

    expect(await findBotProcesses(makeDeps(processes))).toEqual([]);
  });

  it("terminates on a ppid cycle", async () => {
    const processes = [
      proc(9000, 8000, "-zsh"),
      proc(8000, 9000, `node ${INDEX}`),
      proc(7000, 1, `node ${INDEX}`),
    ];

    const result = await findBotProcesses(makeDeps(processes));

    expect(result.map((p) => p.pid)).toEqual([7000]);
  });

  it("excludes pids in excludePids", async () => {
    const result = await findBotProcesses(
      makeDeps([proc(100, 1, `node ${INDEX}`), proc(200, 1, `node ${INDEX}`)], {
        excludePids: [100],
      }),
    );

    expect(result.map((p) => p.pid)).toEqual([200]);
  });

  it("never reads cwd or realpath for processes that are not node", async () => {
    const calls: string[] = [];
    await findBotProcesses(
      makeDeps([proc(100, 1, `vim ${INDEX}`)], {
        cwdOf: async (pid) => {
          calls.push(`cwd:${pid}`);
          return null;
        },
        realpath: async (p) => {
          calls.push(`real:${p}`);
          return p;
        },
      }),
    );

    expect(calls).toEqual([]);
  });
});
