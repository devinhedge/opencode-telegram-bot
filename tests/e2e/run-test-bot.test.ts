import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The launchers are exercised for real, from a temporary copy of e2e/ with a fake
// .env, so nothing in the working copy is touched. Every case here must be rejected
// before the build: each asserts its own message, so a check that failed to stop
// the launcher cannot pass by failing later.

const E2E_DIR = resolve(__dirname, "../../e2e");
const BASE_ENV = "TELEGRAM_BOT_TOKEN=123456:TEST-token-value\nTELEGRAM_ALLOWED_USER_ID=1\n";
const SUPPORTED = "socks, socks4, socks4a, socks5, socks5h, http, https";

interface Launcher {
  name: string;
  script: string;
  enabled: boolean;
  forwardProxy: (scheme: string) => string[];
  faultProxy: string;
  command: (scriptPath: string, args: string[]) => [string, string[]];
}

const LAUNCHERS: Launcher[] = [
  {
    name: "PowerShell",
    script: "run-test-bot.ps1",
    enabled: process.platform === "win32",
    forwardProxy: (scheme) => ["-ForwardProxy", scheme],
    faultProxy: "-FaultProxy",
    command: (scriptPath, args) => [
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    ],
  },
  {
    name: "shell",
    script: "run-test-bot.sh",
    enabled: process.platform !== "win32",
    forwardProxy: (scheme) => ["--forward-proxy", scheme],
    faultProxy: "--fault-proxy",
    command: (scriptPath, args) => ["bash", [scriptPath, ...args]],
  },
];

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run-test-bot-test-"));
  mkdirSync(join(root, "e2e"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function launch(
  launcher: Launcher,
  args: string[],
  options: { env?: string; inherited?: Record<string, string> } = {},
): Promise<{ code: number | null; output: string }> {
  const scriptPath = join(root, "e2e", launcher.script);
  copyFileSync(join(E2E_DIR, launcher.script), scriptPath);
  if (options.env !== undefined) {
    writeFileSync(join(root, "e2e", ".env"), options.env);
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...options.inherited };
  if (!options.inherited?.TELEGRAM_PROXY_URL) delete env.TELEGRAM_PROXY_URL;
  if (!options.inherited?.TELEGRAM_API_ROOT) delete env.TELEGRAM_API_ROOT;

  const [command, commandArgs] = launcher.command(scriptPath, args);
  const child = spawn(command, commandArgs, { cwd: root, env });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  return new Promise((resolveRun) => child.on("exit", (code) => resolveRun({ code, output })));
}

/** PowerShell wraps error records at the console width, even mid-word. */
function expectMessage(output: string, message: string) {
  expect(output.replace(/\s/g, "")).toContain(message.replace(/\s/g, ""));
}

function expectStoppedBeforeBuild(result: { code: number | null; output: string }) {
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain("Building...");
  expect(existsSync(join(root, ".tmp", "e2e", "forward-proxy"))).toBe(false);
}

for (const launcher of LAUNCHERS) {
  describe.runIf(launcher.enabled)(`${launcher.name} launcher forward-proxy mode`, () => {
    it.each(["ftp", "SOCKS5"])("rejects the scheme %s before anything starts", async (scheme) => {
      const result = await launch(launcher, launcher.forwardProxy(scheme));

      expectMessage(result.output, `scheme '${scheme}'. Supported: ${SUPPORTED}.`);
      expectStoppedBeforeBuild(result);
      expect(existsSync(join(root, "e2e", ".env"))).toBe(false);
      expect(existsSync(join(root, ".tmp"))).toBe(false);
    });

    it("rejects the combination with the fault proxy", async () => {
      const result = await launch(
        launcher,
        [...launcher.forwardProxy("socks5h"), launcher.faultProxy],
        { env: BASE_ENV },
      );

      expectMessage(result.output, "cannot be combined with");
      expectStoppedBeforeBuild(result);
    });

    it.each(["TELEGRAM_PROXY_URL=socks5://10.0.0.1:1080", "TELEGRAM_API_ROOT=https://relay.test"])(
      "rejects %s set in e2e/.env",
      async (line) => {
        const name = line.split("=")[0];

        const result = await launch(launcher, launcher.forwardProxy("http"), {
          env: `${BASE_ENV}${line}\n`,
        });

        expectMessage(
          result.output,
          `cannot be used while ${name} is set in e2e/.env or the environment.`,
        );
        expectStoppedBeforeBuild(result);
      },
    );

    it.each(["TELEGRAM_PROXY_URL", "TELEGRAM_API_ROOT"])(
      "rejects %s inherited from the environment",
      async (name) => {
        const result = await launch(launcher, launcher.forwardProxy("socks4a"), {
          env: BASE_ENV,
          inherited: { [name]: "http://127.0.0.1:9" },
        });

        expectMessage(
          result.output,
          `cannot be used while ${name} is set in e2e/.env or the environment.`,
        );
        expectStoppedBeforeBuild(result);
      },
    );
  });
}

describe("harness scripts keep the bot's logs in the isolated home", () => {
  const read = (name: string) => readFileSync(join(E2E_DIR, name), "utf8");

  it.runIf(process.platform !== "win32")(
    "the shell launcher gives the bot LOG_LOCATION=app, over the environment and e2e/.env",
    async () => {
      const binDir = join(root, "bin");
      const record = join(root, "bot-env.txt");
      mkdirSync(binDir);
      // A fake npm answers `npm root -g`; a fake node records what the bot would see.
      writeFileSync(join(binDir, "npm"), "#!/bin/sh\necho /nonexistent-npm-root\n");
      writeFileSync(
        join(binDir, "node"),
        '#!/bin/sh\nprintf "%s" "$LOG_LOCATION" > "$RECORD_FILE"\n',
      );
      chmodSync(join(binDir, "npm"), 0o755);
      chmodSync(join(binDir, "node"), 0o755);

      const shell = LAUNCHERS.find((launcher) => launcher.name === "shell")!;
      const result = await launch(shell, ["--skip-build"], {
        env: `${BASE_ENV}LOG_LOCATION=default\n`,
        inherited: {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          RECORD_FILE: record,
          LOG_LOCATION: "default",
        },
      });

      expect(result.code).toBe(0);
      expect(readFileSync(record, "utf8")).toBe("app");
    },
  );

  describe("the PowerShell launcher", () => {
    const lines = () => read("run-test-bot.ps1").split(/\r?\n/);
    const isCode = (line: string) => !line.trim().startsWith("#");

    it("assigns LOG_LOCATION=app on a code line before the bot is started", () => {
      const all = lines();
      const assignment = all.findIndex(
        (line) => isCode(line) && /^\s*\$env:LOG_LOCATION\s*=\s*"app"\s*$/.test(line),
      );
      const start = all.findIndex((line) => isCode(line) && /^\s*node\s+\(Join-Path/.test(line));

      expect(assignment).toBeGreaterThan(-1);
      expect(start).toBeGreaterThan(-1);
      expect(assignment).toBeLessThan(start);
    });

    it("saves the previous value before the assignment and restores it inside finally", () => {
      const all = lines();
      const saved = all.findIndex(
        (line) =>
          isCode(line) && /^\s*\$previousLogLocation\s*=\s*\$env:LOG_LOCATION\s*$/.test(line),
      );
      const assignment = all.findIndex(
        (line) => isCode(line) && /^\s*\$env:LOG_LOCATION\s*=\s*"app"\s*$/.test(line),
      );
      const start = all.findIndex((line) => isCode(line) && /^\s*node\s+\(Join-Path/.test(line));
      const finallyStart = all.findIndex(
        (line, index) => index > start && isCode(line) && /^\s*}\s*finally\s*{\s*$/.test(line),
      );
      const restore = all.findIndex(
        (line) =>
          isCode(line) &&
          /^\s*Restore-EnvValue\s+"LOG_LOCATION"\s+\$previousLogLocation\s*$/.test(line),
      );

      expect(saved).toBeGreaterThan(-1);
      expect(saved).toBeLessThan(assignment);
      expect(finallyStart).toBeGreaterThan(start);
      expect(restore).toBeGreaterThan(finallyStart);
    });
  });

  it.runIf(process.platform !== "win32")(
    "the shell stop script selects main logs only, not service logs or old-style names",
    async () => {
      const logsDir = join(root, ".tmp", "e2e", "home", "logs");
      mkdirSync(logsDir, { recursive: true });
      mkdirSync(join(root, "e2e"), { recursive: true });
      copyFileSync(join(E2E_DIR, "stop-test-bot.sh"), join(root, "e2e", "stop-test-bot.sh"));

      // Live processes whose command line contains dist/index.js, so only the file name
      // decides which of them the script stops.
      const spawnTarget = () =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "dist/index.js"], {
          stdio: "ignore",
        });
      const main = spawnTarget();
      const service = spawnTarget();
      const oldStyle = spawnTarget();
      const children = [main, service, oldStyle];
      try {
        writeFileSync(
          join(logsDir, `opencode-telegram-bot-2026-11-11_10-00-00_${main.pid}.log`),
          "",
        );
        // A service log named so that it ends in _<digits>.log must still not be parsed.
        writeFileSync(
          join(logsDir, `opencode-telegram-bot-service-2026-11-11_10-00-00_${service.pid}.log`),
          "",
        );
        writeFileSync(join(logsDir, `bot-2026-11-11_10-00-00_${oldStyle.pid}.log`), "");
        writeFileSync(join(logsDir, "opencode-telegram-bot-2026-11-11.log"), "");

        const result = await new Promise<number | null>((resolveRun) => {
          const stop = spawn("bash", [join(root, "e2e", "stop-test-bot.sh")], {
            cwd: root,
            stdio: "ignore",
          });
          stop.on("exit", (code) => resolveRun(code));
        });
        expect(result).toBe(0);

        const waitForExit = (child: typeof main) =>
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
        await waitForExit(main);

        expect(main.signalCode).toBe("SIGTERM");
        expect(service.exitCode === null && service.signalCode === null).toBe(true);
        expect(oldStyle.exitCode === null && oldStyle.signalCode === null).toBe(true);
      } finally {
        for (const child of children) child.kill("SIGKILL");
      }
    },
    20_000,
  );

  it("the PowerShell stop script filters to main logs only", () => {
    const script = read("stop-test-bot.ps1");
    expect(script).toContain('-Filter "opencode-telegram-bot-*.log"');
    expect(script).toContain("'^opencode-telegram-bot-\\d'");
  });

  it.each(["stop-test-bot.sh", "stop-test-bot.ps1"])(
    "%s no longer uses the pre-relocation log file name",
    (name) => {
      expect(read(name)).not.toMatch(/[^-]bot-(\*|\[0-9\]\*)\.log/);
    },
  );
});
