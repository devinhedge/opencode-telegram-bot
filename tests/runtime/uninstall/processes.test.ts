import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildScanDeps,
  createCwdReader,
  findBotProcesses,
  globalPackageRoot,
  listProcessesWithPs,
  parseLsofCwd,
  parseProcessList,
  reverifyBotProcess,
  type BotProcess,
  type CommandRunner,
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
const UID = 1000;

function proc(pid: number, ppid: number, args: string, uid = UID): RawProcess {
  return { pid, ppid, uid, user: "dev", startedAt: STARTED, args };
}

function makeDeps(processes: RawProcess[], overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    listProcesses: async () => processes,
    realpath: async (p) => p,
    cwdOf: async () => null,
    commandLine: async () => null,
    entryPoints: [CLI, INDEX, GLOBAL_CLI],
    ownPid: 9000,
    ownPpid: 8000,
    currentUid: UID,
    excludePids: [],
    ...overrides,
  };
}

// The listing must contain the own pid; ancestors are optional.
const OWN = proc(9000, 8000, "node own-process");

async function scan(processes: RawProcess[], overrides: Partial<ScanDeps> = {}) {
  return findBotProcesses(makeDeps([OWN, ...processes], overrides));
}

describe("parseProcessList", () => {
  it("parses a macOS-style sample with a command line that has spaces", () => {
    const output = [
      "    1     0     0 root             Sat Nov  1 08:00:01 2026 /sbin/launchd",
      "  501   400   501 dev              Mon Nov 12 10:00:00 2026 node /Users/dev/My Projects/bot/dist/index.js",
    ].join("\n");

    expect(parseProcessList(output)).toEqual([
      {
        pid: 1,
        ppid: 0,
        uid: 0,
        user: "root",
        startedAt: "Sat Nov  1 08:00:01 2026",
        args: "/sbin/launchd",
      },
      {
        pid: 501,
        ppid: 400,
        uid: 501,
        user: "dev",
        startedAt: "Mon Nov 12 10:00:00 2026",
        args: "node /Users/dev/My Projects/bot/dist/index.js",
      },
    ]);
  });

  it("parses a Linux-style sample", () => {
    const output = [
      "    1     0     0 root     Wed Nov 11 07:12:44 2026 /sbin/init splash",
      " 2210  2100  1000 devin    Thu Nov 12 09:05:09 2026 node /srv/bot/dist/cli.js start",
    ].join("\n");

    expect(parseProcessList(output)).toEqual([
      {
        pid: 1,
        ppid: 0,
        uid: 0,
        user: "root",
        startedAt: "Wed Nov 11 07:12:44 2026",
        args: "/sbin/init splash",
      },
      {
        pid: 2210,
        ppid: 2100,
        uid: 1000,
        user: "devin",
        startedAt: "Thu Nov 12 09:05:09 2026",
        args: "node /srv/bot/dist/cli.js start",
      },
    ]);
  });

  it("parses output without the lstart column with startedAt null", () => {
    const output = ["    1     0     0 root /sbin/init", " 2210  2100  1000 devin node x.js"].join(
      "\n",
    );

    expect(parseProcessList(output, false)).toEqual([
      { pid: 1, ppid: 0, uid: 0, user: "root", startedAt: null, args: "/sbin/init" },
      { pid: 2210, ppid: 2100, uid: 1000, user: "devin", startedAt: null, args: "node x.js" },
    ]);
  });

  it("ignores empty and malformed lines", () => {
    const output = [
      "",
      "   ",
      "not a process line",
      "abc 1 1000 root Mon Nov 12 10:00:00 2026 node x.js",
      "  42     1  1000 dev     Mon Nov 12 10:00:00 2026 node ok.js",
      "  43     1  1000 dev     Mon Nov 12 10:00:00 2026",
    ].join("\n");

    expect(parseProcessList(output)).toEqual([proc(42, 1, "node ok.js")]);
  });

  it("parses CRLF input", () => {
    const output = [
      "  42     1  1000 dev     Mon Nov 12 10:00:00 2026 node ok.js",
      "  43     1  1000 dev     Mon Nov 12 10:00:00 2026 node two.js",
      "",
    ].join("\r\n");

    expect(parseProcessList(output).map((p) => [p.pid, p.args])).toEqual([
      [42, "node ok.js"],
      [43, "node two.js"],
    ]);
  });

  it("drops a pid forged by an argv with an embedded newline, and the real row it duplicates", () => {
    const forged = `  777     1  1000 dev     Mon Nov 12 10:00:00 2026 node ${INDEX}`;
    const output = [
      "  100     1  1000 dev     Mon Nov 12 10:00:00 2026 node harmless.js",
      `  200     1  1000 dev     Mon Nov 12 10:00:00 2026 node x.js\n${forged}`,
      "  777     1  1000 dev     Mon Nov 12 10:00:00 2026 vim notes.txt",
    ].join("\n");

    const result = parseProcessList(output);

    expect(result.map((p) => p.pid)).toEqual([100, 200]);
  });

  it("drops a continuation fragment that has no row structure", () => {
    const output = [
      "  200     1  1000 dev     Mon Nov 12 10:00:00 2026 node x.js\ncontinued fragment",
    ].join("\n");

    expect(parseProcessList(output).map((p) => p.pid)).toEqual([200]);
  });
});

describe("parseLsofCwd", () => {
  it("returns the path from the n field", () => {
    expect(parseLsofCwd("p123\nfcwd\nn/home/dev/project\n")).toBe("/home/dev/project");
  });

  it("returns null for empty or field-less output", () => {
    expect(parseLsofCwd("")).toBeNull();
    expect(parseLsofCwd("p123\nfcwd\n")).toBeNull();
    expect(parseLsofCwd("p123\nfcwd\nn\n")).toBeNull();
  });
});

describe("findBotProcesses", () => {
  it("lists a node process that runs the dist/index.js entry point", async () => {
    const result = await scan([proc(100, 1, `node ${INDEX}`)]);

    expect(result).toEqual([
      { pid: 100, user: "dev", startedAt: STARTED, commandLine: `node ${INDEX}`, verified: true },
    ]);
  });

  it("lists index.js regardless of its arguments", async () => {
    const result = await scan([proc(100, 1, `node ${INDEX} stop`)]);

    expect(result.map((p) => p.pid)).toEqual([100]);
  });

  it("lists dist/cli.js when its arguments mean start, including the default", async () => {
    const result = await scan([
      proc(100, 1, `node ${CLI} start`),
      proc(101, 1, `node ${CLI} start --daemon`),
      proc(102, 1, `node ${CLI}`),
      proc(103, 1, `node ${CLI} --daemon`),
      proc(104, 1, `node ${CLI} --mode installed`),
      proc(105, 1, `node ${CLI} --restart`),
      proc(106, 1, `node ${CLI} --mode=sources`),
    ]);

    expect(result.map((p) => p.pid)).toEqual([100, 101, 102, 103, 104, 105, 106]);
  });

  it("does not list dist/cli.js for other commands, help, or invalid arguments", async () => {
    const result = await scan([
      proc(100, 1, `node ${CLI} uninstall`),
      proc(101, 1, `node ${CLI} config`),
      proc(102, 1, `node ${CLI} status`),
      proc(103, 1, `node ${CLI} stop`),
      proc(104, 1, `node ${CLI} --help`),
      proc(105, 1, `node ${CLI} --bogus`),
      proc(106, 1, `node ${CLI} --mode`),
      proc(107, 1, `node ${CLI} frobnicate`),
      proc(108, 1, `node ${CLI} stop --daemon`),
    ]);

    expect(result).toEqual([]);
  });

  it("accepts nodejs and a path-qualified node as argv0", async () => {
    const result = await scan([
      proc(100, 1, `nodejs ${INDEX}`),
      proc(101, 1, `/usr/local/bin/node ${INDEX}`),
      proc(102, 1, `node-wrapper ${INDEX}`),
    ]);

    expect(result.map((p) => p.pid)).toEqual([100, 101]);
  });

  it("skips node options before the script", async () => {
    const result = await scan([
      proc(100, 1, `node --enable-source-maps --no-warnings ${INDEX}`),
      proc(101, 1, `node -r ./preload.js ${INDEX}`),
      proc(102, 1, `node --require ./preload.js --import ./hook.mjs ${INDEX}`),
      proc(103, 1, `node --max-old-space-size=512 -- ${INDEX}`),
    ]);

    expect(result.map((p) => p.pid)).toEqual([100, 101, 102, 103]);
  });

  it("fails closed on an unknown option before the script", async () => {
    const result = await scan([
      proc(100, 1, `node --test-name-pattern ${INDEX}`),
      proc(101, 1, `node --some-unknown-flag ${INDEX}`),
      proc(102, 1, `node --no-warnings ${INDEX}`),
      proc(103, 1, `node --max-old-space-size=4096 ${INDEX}`),
      proc(104, 1, `node --no-warnings --some-unknown-flag ${INDEX}`),
      proc(105, 1, `node -x ${INDEX}`),
    ]);

    expect(result.map((p) => p.pid)).toEqual([102, 103]);
  });

  it("never signals a forged row: the scan may list it, reverify rejects it", async () => {
    const forged = `  777     1  1000 dev     Mon Nov 12 10:00:00 2026 node ${INDEX}`;
    const output = [
      "  9000   8000  1000 dev     Mon Nov 12 10:00:00 2026 node own-process",
      `  200     1  1000 dev     Mon Nov 12 10:00:00 2026 node x.js\n${forged}`,
    ].join("\n");
    const deps = makeDeps([], {
      listProcesses: async () => parseProcessList(output),
      commandLine: async () => null,
    });

    const result = await findBotProcesses(deps);

    expect(result.map((p) => p.pid)).toEqual([777]);
    expect(await reverifyBotProcess(result[0] as BotProcess, deps)).toBe(false);
  });

  it("does not match an entry point that is only the value of a node option", async () => {
    const result = await scan([
      proc(100, 1, `node -p ${INDEX}`),
      proc(101, 1, `node -r ${INDEX} other.js`),
      proc(102, 1, `node -e ${INDEX}`),
      proc(103, 1, `node --eval ${INDEX}`),
      proc(104, 1, `node --import ${INDEX} other.js`),
      proc(105, 1, "node"),
      proc(106, 1, "node -r"),
    ]);

    expect(result).toEqual([]);
  });

  it("matches a launcher symlink through its realpath", async () => {
    const launcher = path.resolve("/usr/local/bin/opencode-telegram");
    const result = await scan([proc(100, 1, `node ${launcher} start`)], {
      realpath: async (p) => (p === launcher ? GLOBAL_CLI : p),
    });

    expect(result.map((p) => p.pid)).toEqual([100]);
  });

  it("does not match a launcher symlink running uninstall", async () => {
    const launcher = path.resolve("/usr/local/bin/opencode-telegram");
    const result = await scan([proc(100, 1, `node ${launcher} uninstall`)], {
      realpath: async (p) => (p === launcher ? GLOBAL_CLI : p),
    });

    expect(result).toEqual([]);
  });

  it("does not match a launcher symlink to a different file", async () => {
    const launcher = path.resolve("/usr/local/bin/other-tool");
    const result = await scan([proc(100, 1, `node ${launcher} start`)], {
      realpath: async (p) => (p === launcher ? OTHER_CHECKOUT_INDEX : p),
    });

    expect(result).toEqual([]);
  });

  it("resolves a relative script against the process cwd", async () => {
    const result = await scan(
      [proc(100, 1, "node dist/index.js"), proc(101, 1, "node dist/index.js")],
      {
        cwdOf: async (pid) => (pid === 100 ? ROOT : path.resolve("/home/other/checkout")),
      },
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

  it("resolves bare and dotted relative scripts against the cwd when it is known", async () => {
    const result = await scan(
      [proc(100, 1, "node ./cli.js start"), proc(101, 1, "node index.js")],
      { cwdOf: async () => path.join(ROOT, "dist") },
    );

    expect(result.map((p) => p.pid)).toEqual([100, 101]);
  });

  it("lists a two-component relative script with an unknown cwd as unverified", async () => {
    const result = await scan([
      proc(100, 1, "node dist/index.js"),
      proc(101, 1, "node ./dist/cli.js start"),
    ]);

    expect(result).toEqual([
      {
        pid: 100,
        user: "dev",
        startedAt: STARTED,
        commandLine: "node dist/index.js",
        verified: false,
      },
      {
        pid: 101,
        user: "dev",
        startedAt: STARTED,
        commandLine: "node ./dist/cli.js start",
        verified: false,
      },
    ]);
  });

  it("never lists a bare single-component script with an unknown cwd", async () => {
    const result = await scan([
      proc(100, 1, "node index.js"),
      proc(101, 1, "node ./index.js"),
      proc(102, 1, "node cli.js start"),
      proc(103, 1, "node ./cli.js"),
    ]);

    expect(result).toEqual([]);
  });

  it("does not list an unknown-cwd relative script that is not an entry point suffix", async () => {
    const result = await scan([
      proc(100, 1, "node src/index.js"),
      proc(101, 1, "node ../dist/index.js"),
      proc(102, 1, "node dist/cli.js uninstall"),
      proc(103, 1, "node xdist/index.js"),
    ]);

    expect(result).toEqual([]);
  });

  it("lists a dangling symlink script by its lexical path", async () => {
    const result = await scan([proc(100, 1, `node ${INDEX}`)], {
      realpath: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    expect(result.map((p) => p.pid)).toEqual([100]);
  });

  it("does not match a bot run from another checkout", async () => {
    const result = await scan([proc(100, 1, `node ${OTHER_CHECKOUT_INDEX}`)]);

    expect(result).toEqual([]);
  });

  it("does not match an editor or grep that mentions the script path", async () => {
    const result = await scan([
      proc(100, 1, `vim ${INDEX}`),
      proc(101, 1, "grep opencode-telegram"),
      proc(102, 1, `code ${CLI} start`),
      proc(103, 1, `tail -f ${INDEX}`),
    ]);

    expect(result).toEqual([]);
  });

  it("treats a script path with spaces as a false negative", async () => {
    const spaced = path.resolve("/opt/my checkout/dist/index.js");
    const result = await scan([proc(100, 1, `node ${spaced}`)], { entryPoints: [spaced] });

    expect(result).toEqual([]);
  });

  it("scans only processes of the current user", async () => {
    const result = await scan([proc(100, 1, `node ${INDEX}`, 0), proc(101, 1, `node ${INDEX}`)]);

    expect(result.map((p) => p.pid)).toEqual([101]);
  });

  it("lists nothing when the platform has no uid", async () => {
    const result = await scan([proc(100, 1, `node ${INDEX}`)], { currentUid: null });

    expect(result).toEqual([]);
  });

  it("never lists the own pid or its ancestor chain", async () => {
    const result = await findBotProcesses(
      makeDeps([
        proc(9000, 8000, `node ${CLI} start`),
        proc(8000, 7000, `node ${CLI} start`),
        proc(7000, 6000, "make uninstall # opencode-telegram uninstall"),
        proc(6000, 1, `node ${INDEX}`),
        proc(5000, 1, `node ${INDEX}`),
      ]),
    );

    expect(result.map((p) => p.pid)).toEqual([5000]);
  });

  it("excludes an ancestor bot even when it matches an entry point", async () => {
    const result = await findBotProcesses(
      makeDeps([
        proc(9000, 8500, `node ${CLI} uninstall`),
        proc(8500, 8400, "npm exec opencode-telegram uninstall"),
        proc(8400, 8300, `node ${INDEX}`),
        proc(8300, 1, "-zsh"),
      ]),
    );

    expect(result).toEqual([]);
  });

  it("terminates on a ppid cycle", async () => {
    const result = await findBotProcesses(
      makeDeps([
        proc(9000, 8100, "-zsh"),
        proc(8100, 9000, `node ${INDEX}`),
        proc(7000, 1, `node ${INDEX}`),
      ]),
    );

    expect(result.map((p) => p.pid)).toEqual([7000]);
  });

  it("excludes the own parent pid even when it is missing from the listing", async () => {
    const result = await findBotProcesses(
      makeDeps([proc(9000, 8000, "node own"), proc(8000, 1, `node ${INDEX}`)], { ownPpid: 8000 }),
    );

    expect(result).toEqual([]);
  });

  it("throws when the listing does not contain the own pid", async () => {
    await expect(findBotProcesses(makeDeps([proc(100, 1, `node ${INDEX}`)]))).rejects.toThrow(
      /own pid 9000/,
    );
  });

  it("excludes pids in excludePids", async () => {
    const result = await scan([proc(100, 1, `node ${INDEX}`), proc(200, 1, `node ${INDEX}`)], {
      excludePids: [100],
    });

    expect(result.map((p) => p.pid)).toEqual([200]);
  });

  it("never reads cwd for processes that are not node", async () => {
    const calls: string[] = [];
    await scan([proc(100, 1, `vim ${INDEX}`)], {
      cwdOf: async (pid) => {
        calls.push(`cwd:${pid}`);
        return null;
      },
    });

    expect(calls).toEqual([]);
  });

  it("resolves entry point realpaths once, before the per-process loop", async () => {
    const calls: string[] = [];
    await scan([proc(100, 1, `node ${INDEX}`), proc(101, 1, `node ${INDEX}`)], {
      entryPoints: [INDEX],
      realpath: async (p) => {
        calls.push(p);
        return p;
      },
    });

    expect(calls.filter((p) => p === INDEX)).toHaveLength(1 + 2);
  });
});

describe("reverifyBotProcess", () => {
  const listed: BotProcess = {
    pid: 100,
    user: "dev",
    startedAt: STARTED,
    commandLine: `node ${INDEX}`,
    verified: true,
  };

  it("returns true when the command line is unchanged and still matches", async () => {
    const deps = makeDeps([], { commandLine: async () => `node ${INDEX}` });

    expect(await reverifyBotProcess(listed, deps)).toBe(true);
  });

  it("returns false when the command line changed", async () => {
    const deps = makeDeps([], { commandLine: async () => `node ${INDEX} --extra` });

    expect(await reverifyBotProcess(listed, deps)).toBe(false);
  });

  it("returns false when the command line cannot be read", async () => {
    const deps = makeDeps([], { commandLine: async () => null });

    expect(await reverifyBotProcess(listed, deps)).toBe(false);
  });

  it("returns false when the pid was reused by an unrelated command", async () => {
    const reused: BotProcess = { ...listed, commandLine: "vim notes.txt" };
    const deps = makeDeps([], { commandLine: async () => "vim notes.txt" });

    expect(await reverifyBotProcess(reused, deps)).toBe(false);
  });

  it("returns false when an equal line no longer matches an entry point", async () => {
    const deps = makeDeps([], {
      commandLine: async () => `node ${INDEX}`,
      entryPoints: [CLI],
    });

    expect(await reverifyBotProcess(listed, deps)).toBe(false);
  });

  it("returns false for the own pid and for excluded pids", async () => {
    const deps = makeDeps([], { commandLine: async () => `node ${INDEX}`, excludePids: [100] });

    expect(await reverifyBotProcess(listed, deps)).toBe(false);
    expect(await reverifyBotProcess({ ...listed, pid: 9000 }, deps)).toBe(false);
  });
});

describe("default dependency helpers", () => {
  function runnerReturning(results: Record<string, string | Error>): {
    runner: CommandRunner;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      const result = results[`${file} ${args.join(" ")}`];
      if (result === undefined || result instanceof Error) {
        throw result ?? new Error("unexpected command");
      }
      return { stdout: result };
    };
    return { runner, calls };
  }

  it("lists processes with lstart when ps supports it", async () => {
    const { runner, calls } = runnerReturning({
      "ps -axo pid=,ppid=,uid=,user=,lstart=,args=":
        "  42     1  1000 dev     Mon Nov 12 10:00:00 2026 node ok.js\n",
    });

    expect(await listProcessesWithPs(runner)).toEqual([proc(42, 1, "node ok.js")]);
    expect(calls).toHaveLength(1);
  });

  it("retries once without lstart and sets startedAt to null", async () => {
    const { runner, calls } = runnerReturning({
      "ps -axo pid=,ppid=,uid=,user=,lstart=,args=": new Error("bad column"),
      "ps -axo pid=,ppid=,uid=,user=,args=": "  42     1  1000 dev node ok.js\n",
    });

    expect(await listProcessesWithPs(runner)).toEqual([
      { pid: 42, ppid: 1, uid: 1000, user: "dev", startedAt: null, args: "node ok.js" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("rejects when ps fails both times", async () => {
    const { runner } = runnerReturning({});

    await expect(listProcessesWithPs(runner)).rejects.toThrow();
  });

  it("reads the global package root from npm root -g", async () => {
    const { runner } = runnerReturning({ "npm root -g": "/usr/lib/node_modules\n" });

    expect(await globalPackageRoot(runner, "linux")).toBe(GLOBAL_ROOT);
  });

  it("returns null for the global package root on failure and on win32", async () => {
    const failing = runnerReturning({ "npm root -g": new Error("no npm") });
    const empty = runnerReturning({ "npm root -g": "\n" });
    const win = runnerReturning({ "npm root -g": "/x" });

    expect(await globalPackageRoot(failing.runner, "linux")).toBeNull();
    expect(await globalPackageRoot(empty.runner, "linux")).toBeNull();
    expect(await globalPackageRoot(win.runner, "win32")).toBeNull();
    expect(win.calls).toEqual([]);
  });

  it("builds entry points for the package roots and the global root", async () => {
    const { runner } = runnerReturning({ "npm root -g": "/usr/lib/node_modules\n" });

    const deps = await buildScanDeps([ROOT], runner, {
      platform: "linux",
      readlink: async () => "",
    });

    expect(deps.entryPoints).toEqual([
      CLI,
      INDEX,
      GLOBAL_CLI,
      path.join(GLOBAL_ROOT, "dist", "index.js"),
    ]);
    expect(deps.ownPid).toBe(process.pid);
  });

  it("reads the cwd from /proc on Linux and falls back to lsof", async () => {
    const lsofCalls: number[] = [];
    const read = createCwdReader({
      platform: "linux",
      readlink: async (target) => {
        if (target === "/proc/1/cwd") {
          return "/srv/bot";
        }
        throw new Error("EACCES");
      },
      lsofCwd: async (pid) => {
        lsofCalls.push(pid);
        return "/from/lsof";
      },
    });

    expect(await read(1)).toBe("/srv/bot");
    expect(await read(2)).toBe("/from/lsof");
    expect(lsofCalls).toEqual([2]);
  });

  it("uses lsof only on macOS", async () => {
    const read = createCwdReader({
      platform: "darwin",
      readlink: async () => {
        throw new Error("must not be called");
      },
      lsofCwd: async () => "/from/lsof",
    });

    expect(await read(1)).toBe("/from/lsof");
  });
});
