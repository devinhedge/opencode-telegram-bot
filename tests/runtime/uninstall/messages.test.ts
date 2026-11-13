import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ar } from "../../../src/i18n/ar.js";
import { de } from "../../../src/i18n/de.js";
import { en, type I18nDictionary, type I18nKey } from "../../../src/i18n/en.js";
import { es } from "../../../src/i18n/es.js";
import { fr } from "../../../src/i18n/fr.js";
import { id } from "../../../src/i18n/id.js";
import { it as itLocale } from "../../../src/i18n/it.js";
import { ko } from "../../../src/i18n/ko.js";
import { pt } from "../../../src/i18n/pt.js";
import { ru } from "../../../src/i18n/ru.js";
import { tr } from "../../../src/i18n/tr.js";
import { zh } from "../../../src/i18n/zh.js";
import type { Locale } from "../../../src/i18n/index.js";
import {
  createUninstallTranslator,
  redactCommandLine,
  resolveUninstallLocale,
} from "../../../src/runtime/uninstall/messages.js";

// Key (without the uninstall. prefix) -> sorted placeholder names. This table is the contract
// with the executor: every key of en under uninstall. must appear here with exactly these.
const PLACEHOLDERS: Record<string, string[]> = {
  refused_container: [],
  refused_root: [],
  plan_header: [],
  plan_daemon: ["pid"],
  plan_terminal_bots: [],
  plan_systemd: ["path"],
  plan_home: ["path"],
  plan_override: ["path"],
  plan_keychain: ["service"],
  plan_logs_stay: ["path"],
  plan_opencode_server: [],
  confirm_plan: [],
  confirm_override: ["path"],
  confirm_stop_process: ["command", "pid", "started", "user"],
  confirm_stop_opencode: ["command", "pid", "port"],
  confirm_stop_opencode_tree: [],
  no_terminal_plan_only: [],
  aborted: [],
  step_daemon_stopped: ["pid"],
  step_daemon_failed: ["pid"],
  step_daemon_absent: [],
  step_daemon_error: ["reason"],
  step_removed: ["path"],
  step_absent: ["path"],
  step_failed: ["path", "reason"],
  step_link_removed: ["path", "target"],
  step_target_left: ["path"],
  step_home_error: ["path", "reason"],
  step_keychain: ["account", "status"],
  step_keychain_unavailable: [],
  keychain_status_removed: [],
  keychain_status_absent: [],
  keychain_status_failed: [],
  step_systemd: ["outcome"],
  step_systemd_failed: ["reason"],
  step_systemd_commands: ["commands"],
  systemd_outcome_removed: [],
  systemd_outcome_absent: [],
  systemd_outcome_not_applicable: [],
  systemd_outcome_skipped_no_terminal: [],
  systemd_outcome_skipped_no_sudo: [],
  systemd_outcome_failed: [],
  step_scan_failed: ["reason"],
  step_scan_unsupported: [],
  step_process_stopped: ["pid"],
  step_process_failed: ["pid"],
  step_process_skipped: ["pid"],
  step_process_refused: ["pid"],
  process_unverified: ["pid"],
  started_unknown: [],
  step_override_invalid: ["path", "reason"],
  step_override_skipped: ["path"],
  override_reason_missing: [],
  override_reason_unreadable: [],
  override_reason_not_a_directory: [],
  override_reason_root: [],
  override_reason_user_home: [],
  override_reason_no_bot_files: [],
  step_opencode_stopped: ["pid"],
  step_opencode_failed: ["pid"],
  step_opencode_skipped: [],
  step_opencode_refused: ["pid"],
  step_opencode_none: [],
  command_unavailable: [],
  home_removed: ["path"],
  home_kept: ["path"],
  summary_ok: [],
  left_process: ["pid"],
  left_opencode: ["pid"],
  left_keychain: [],
  summary_left: ["items"],
  summary_failed: ["count"],
  cli_hint: ["command"],
  plan_override_secrets: ["path"],
  step_override_secrets: ["path"],
  left_override_kept: ["path"],
  left_scan: [],
  left_daemon: [],
  summary_failed_left: ["count", "items"],
  list_separator: [],
  step_systemd_ran: ["commands", "path"],
  step_process_skipped_no_terminal: ["pid"],
  step_opencode_skipped_no_terminal: [],
  step_override_skipped_no_terminal: ["path"],
  step_logs_warning: [],
  step_homes_error: ["reason"],
  home_kept_logs: ["path"],
  step_process_already_exited: ["pid"],
  step_opencode_gone: ["pid"],
  step_opencode_unknown: ["pid"],
  step_opencode_unchecked: [],
  left_opencode_unchecked: [],
};

const REQUIRED_KEYS = Object.keys(PLACEHOLDERS);

const LOCALES: Record<Exclude<Locale, "en">, I18nDictionary> = {
  ar,
  de,
  es,
  fr,
  id,
  it: itLocale,
  ko,
  pt,
  ru,
  tr,
  zh,
};

// Keys whose translation may legitimately equal the English text, each with a reason.
const SAME_AS_ENGLISH: Record<string, string> = {
  list_separator:
    "a comma and a space separate list items in the Latin and Cyrillic scripts and in Korean",
};

function placeholdersOf(template: string): string[] {
  return [
    ...new Set([...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1] ?? "")),
  ].sort();
}

describe("runtime/uninstall/messages", () => {
  let tempRoot: string;
  let envFilePath: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uninstall-messages-"));
    envFilePath = path.join(tempRoot, ".env");
    vi.stubEnv("BOT_LOCALE", undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("defines every uninstall key in en and no others", () => {
    const actual = Object.keys(en)
      .filter((key) => key.startsWith("uninstall."))
      .map((key) => key.slice("uninstall.".length))
      .sort();

    expect(actual).toEqual([...REQUIRED_KEYS].sort());
  });

  it("pins the exact placeholders of every key", () => {
    for (const key of REQUIRED_KEYS) {
      const template = en[`uninstall.${key}` as I18nKey];
      expect(placeholdersOf(template), key).toEqual(PLACEHOLDERS[key]);
    }
  });

  it("ends every confirmation prompt with [y/N] in every locale", () => {
    const prompts = REQUIRED_KEYS.filter(
      (key) => key.startsWith("confirm_") && key !== "confirm_stop_opencode_tree",
    );
    expect(prompts.length).toBeGreaterThan(0);

    for (const dictionary of [en, ...Object.values(LOCALES)]) {
      for (const key of prompts) {
        expect(dictionary[`uninstall.${key}` as I18nKey], key).toMatch(/\[y\/N\] $/);
      }
    }
  });

  it("puts a left-to-right mark (U+200E) before [y/N] in every Arabic prompt", () => {
    const keys = [
      "uninstall.confirm_plan",
      "uninstall.confirm_override",
      "uninstall.confirm_stop_process",
      "uninstall.confirm_stop_opencode",
    ] as const;

    for (const key of keys) {
      expect(ar[key], key).toContain(" ‎[y/N] ");
      expect(ar[key], key).toMatch(/\[y\/N\] $/);
    }
  });

  describe("resolveUninstallLocale", () => {
    it("prefers the real environment over the .env file", async () => {
      await fs.writeFile(envFilePath, "BOT_LOCALE=fr\n");

      await expect(resolveUninstallLocale({ BOT_LOCALE: "de" }, envFilePath)).resolves.toBe("de");
    });

    it("lets a non-blank but unsupported real-environment value win over .env", async () => {
      await fs.writeFile(envFilePath, "BOT_LOCALE=fr\n");

      await expect(
        resolveUninstallLocale({ BOT_LOCALE: "xx" }, envFilePath),
      ).resolves.toBeUndefined();
    });

    it("reads the .env file when the environment value is blank", async () => {
      await fs.writeFile(envFilePath, "BOT_LOCALE=fr\n");

      await expect(resolveUninstallLocale({ BOT_LOCALE: "  " }, envFilePath)).resolves.toBe("fr");
    });

    it("reads the .env file when the environment lacks BOT_LOCALE", async () => {
      await fs.writeFile(envFilePath, "BOT_LOCALE=fr\n");

      await expect(resolveUninstallLocale({}, envFilePath)).resolves.toBe("fr");
    });

    it("returns undefined for an unsupported value", async () => {
      await fs.writeFile(envFilePath, "BOT_LOCALE=xx\n");

      await expect(resolveUninstallLocale({}, envFilePath)).resolves.toBeUndefined();
    });

    it("returns undefined when the .env file is missing", async () => {
      await expect(resolveUninstallLocale({}, envFilePath)).resolves.toBeUndefined();
    });

    it.skipIf(process.platform === "win32")(
      "never reads a FIFO at the .env path (it would block)",
      async () => {
        execFileSync("mkfifo", [envFilePath]);

        await expect(resolveUninstallLocale({}, envFilePath)).resolves.toBeUndefined();
      },
      3000,
    );

    it.skipIf(process.platform === "win32")(
      "follows a symlinked .env to a regular file",
      async () => {
        const target = path.join(tempRoot, "real.env");
        await fs.writeFile(target, "BOT_LOCALE=fr\n");
        await fs.symlink(target, envFilePath);

        await expect(resolveUninstallLocale({}, envFilePath)).resolves.toBe("fr");
      },
    );

    it("uses only the environment for a null path", async () => {
      await expect(resolveUninstallLocale({ BOT_LOCALE: "de" }, null)).resolves.toBe("de");
      await expect(resolveUninstallLocale({}, null)).resolves.toBeUndefined();
    });

    it("returns undefined without throwing when the .env path is not readable as a file", async () => {
      await fs.mkdir(envFilePath);

      await expect(resolveUninstallLocale({}, envFilePath)).resolves.toBeUndefined();
    });
  });

  describe("createUninstallTranslator", () => {
    it("returns the German text for de", () => {
      const translate = createUninstallTranslator("de");

      expect(translate("uninstall.aborted")).toBe(de["uninstall.aborted"]);
      expect(translate("uninstall.aborted")).not.toBe(en["uninstall.aborted"]);
    });

    it("returns the English text with no locale", () => {
      const translate = createUninstallTranslator(undefined);

      expect(translate("uninstall.step_removed", { path: "/x" })).toBe("Removed /x");
    });

    it("returns English for an undefined locale even when BOT_LOCALE is set", () => {
      vi.stubEnv("BOT_LOCALE", "de");
      const translate = createUninstallTranslator(undefined);

      expect(translate("uninstall.aborted")).toBe(en["uninstall.aborted"]);
    });

    for (const [code, dictionary] of Object.entries(LOCALES)) {
      it(`translates every key into a non-empty text that differs from English (${code})`, () => {
        const translate = createUninstallTranslator(code as Locale);

        for (const key of REQUIRED_KEYS) {
          const fullKey = `uninstall.${key}` as I18nKey;
          const text = translate(fullKey);

          expect(text, key).toBe(dictionary[fullKey]);
          expect(text.trim(), key).not.toBe("");
          expect(text, key).not.toBe(fullKey);
          if (!Object.hasOwn(SAME_AS_ENGLISH, key)) {
            expect(text, `${code} ${key} must not copy English`).not.toBe(en[fullKey]);
          }
        }
      });
    }
  });

  describe("redactCommandLine", () => {
    const SECRET = "S3CR3T";
    const PREFIX = "node /opt/x/cli.js";

    // Attack forms, each carrying SECRET where the secret would be. They run after a normal
    // executable and script and, where it makes sense, also as the whole line.
    const FORMS: string[] = [
      `--token ${SECRET}`,
      `--token=${SECRET}`,
      `TOKEN=${SECRET} cmd`,
      `export API_KEY=${SECRET}`,
      `--password "my ${SECRET}"`,
      `--password='a ${SECRET}'`,
      `Authorization: Bearer ${SECRET} ${SECRET}`,
      `-H "Authorization: Bearer ${SECRET} ${SECRET}"`,
      `Authorization:Bearer ${SECRET}`,
      `-HAuthorization:Bearer ${SECRET}`,
      `--header Authorization:Bearer ${SECRET}`,
      `https://user:${SECRET}@host/x`,
      `http://user@h:${SECRET}@x`,
      `a://b://u:${SECRET}@h`,
      `https://u:${SECRET}/ss@h/`,
      `postgres://u:${SECRET}%40ss@h/db`,
      `--api-key ${SECRET}`,
      `--client_secret=${SECRET}`,
      `--pass ${SECRET}`,
      `--pwd ${SECRET}`,
      `--pw=a=${SECRET},c`,
      `-p ${SECRET}`,
      `-p${SECRET}`,
      `-p=${SECRET}`,
      `-P${SECRET}`,
      `--auth Bearer ${SECRET}`,
      `'TOKEN=a ${SECRET}'`,
      `"--password=a ${SECRET}"`,
      `'--password ${SECRET}'`,
      `--password\\ ${SECRET}`,
      `--token=a'b ${SECRET}'`,
      `--token "a\\" ${SECRET}" tail`,
      `--token=${SECRET}\\ def`,
      `--token='${SECRET}`,
      `--token "${SECRET}`,
      `--password: ${SECRET}`,
      `--token -${SECRET}`,
      `--header=X-Api-Key:${SECRET}`,
      `env KEY=${SECRET} node x.js`,
      `--token\u0000${SECRET}`,
      `--token\u000c${SECRET}`,
      `--token\u000b${SECRET}`,
      `--password\u00a0${SECRET}`,
      `--токен ${SECRET}`,
    ];

    it("leaves ordinary command lines unchanged", () => {
      for (const line of [
        "node /opt/x/dist/cli.js start --daemon --mode installed",
        "node dist/index.js",
        "opencode serve --port 4096 --hostname 127.0.0.1",
        "node /opt/x/dist/cli.js stop",
        "node /opt/x/dist/cli.js --mode=sources --port=4096 uninstall",
      ]) {
        expect(redactCommandLine(line), line).toBe(line);
      }
    });

    for (const form of FORMS) {
      it(`hides the secret in ${JSON.stringify(form)}`, () => {
        expect(redactCommandLine(`${PREFIX} ${form}`)).not.toContain(SECRET);
        expect(redactCommandLine(form)).not.toContain(SECRET);
        expect(redactCommandLine(`${PREFIX} start ${form} --daemon`)).not.toContain(SECRET);
      });
    }

    it("keeps the allowed words and masks everything else", () => {
      expect(redactCommandLine(`${PREFIX} --token ${SECRET} --port 4096`)).toBe(
        `${PREFIX} *** *** --port 4096`,
      );
      expect(redactCommandLine("node x.js --mode=evil")).toBe("node x.js ***");
      expect(redactCommandLine("TOKEN=abc node x.js")).toBe("*** *** x.js");
      expect(redactCommandLine("node x.js --daemon=1 --port=99999999")).toBe(
        "node x.js --daemon=1 ***",
      );
    });

    it("joins tokens with a single space and splits on control and Unicode whitespace", () => {
      expect(redactCommandLine("node\u0000x.js\u00a0\u00a0start\t\n--daemon")).toBe(
        "node x.js start --daemon",
      );
    });

    it("caps the input at 4096 characters and marks the cut", () => {
      const out = redactCommandLine(`${PREFIX} ${"start ".repeat(5000)}`);

      expect(out.length).toBeLessThanOrEqual(4096 + 3);
      expect(out.endsWith("...")).toBe(true);
    });

    it("pins the accepted residual exposures so a change is deliberate", () => {
      // A standalone token of up to five digits is shown.
      expect(redactCommandLine("node x.js 12345")).toBe("node x.js 12345");
      // The first token is shown when it matches the executable pattern.
      expect(redactCommandLine("sk-live123abc --daemon")).toBe("sk-live123abc --daemon");
      // A token ending in .js, .mjs, .cjs, or .ts is shown.
      expect(redactCommandLine("node x.js sk-abc@123.js")).toBe("node x.js sk-abc@123.js");
      expect(redactCommandLine("node x.js a.mjs b.cjs c.ts")).toBe("node x.js a.mjs b.cjs c.ts");
      // --flag=<number|word|IPv4> values are shown.
      expect(redactCommandLine("node x.js --port=4096 --mode=installed --hostname=10.1.2.3")).toBe(
        "node x.js --port=4096 --mode=installed --hostname=10.1.2.3",
      );
    });

    it("shows package and Windows script paths", () => {
      const line =
        "node /home/u/.nvm/versions/node/v22.0.0/lib/node_modules/@grinev/opencode-telegram-bot/dist/cli.js start";

      expect(redactCommandLine(line)).toBe(line);
      expect(redactCommandLine("npx @grinev/opencode-telegram-bot start")).toBe("npx *** start");
      expect(redactCommandLine("C:\\x\\cli.js start")).toBe("C:\\x\\cli.js start");
      expect(redactCommandLine("node ~/x/cli.js start")).toBe("node ~/x/cli.js start");
    });

    it("hides secrets in path-shaped attack forms", () => {
      for (const form of [`x@${SECRET}`, `C:${SECRET}`, `~${SECRET}=a`, `C:\\${SECRET}=a`]) {
        expect(redactCommandLine(`${PREFIX} ${form}`), form).not.toContain(SECRET);
      }
      expect(redactCommandLine(`C:${SECRET}`)).not.toContain(SECRET);
    });

    it("masks a token fragment cut at the cap", () => {
      const pad = (length: number): string => "a ".repeat(2000) + " ".repeat(length - 4000);

      const digits = redactCommandLine(`${pad(4093)}98765432109 tail`);
      expect(digits).not.toContain("987");
      expect(digits.endsWith("***...")).toBe(true);

      const address = redactCommandLine(`${pad(4085)}192.168.1.234 tail`);
      expect(address).not.toContain("192.168.1.2");
      expect(address.endsWith("***...")).toBe(true);

      // A cut on a separator keeps the last whole token.
      expect(redactCommandLine(`${pad(4095)}start tail`).endsWith("***...")).toBe(true);
      expect(redactCommandLine(`${pad(4090)}start tail`).endsWith("start...")).toBe(true);
    });

    it("hides a secret cut at every offset around the cap", () => {
      const tail = ` https://user:SECRETVALUE@h/ --token SECRETVALUE`;
      for (let offset = 4060; offset <= 4100; offset += 1) {
        const filler = `${PREFIX} ${"a ".repeat(3000)}`.slice(0, offset);

        expect(redactCommandLine(filler + tail), String(offset)).not.toContain("SECRET");
      }
    });

    describe("ReDoS", () => {
      const SHAPES: Array<[string, string]> = [
        ["one letter", "a"],
        ["--token ", "--token "],
        ["a=", "a="],
        ["double quote", '"'],
        ["backslash", "\\"],
        ["space", " "],
        ["NUL", "\u0000"],
        ["token", "token"],
      ];

      for (const [label, unit] of SHAPES) {
        it(`finishes fast on 1,000,000 characters of ${label}`, () => {
          const input = unit.repeat(Math.ceil(1_000_000 / unit.length));
          const started = performance.now();
          const out = redactCommandLine(`--token ${SECRET} ${input}`);
          const elapsed = performance.now() - started;

          expect(elapsed).toBeLessThan(500);
          expect(out).not.toContain(SECRET);
        });
      }
    });
  });
});
