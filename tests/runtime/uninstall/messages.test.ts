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
  plan_nothing: [],
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
  summary_left: ["items"],
  summary_failed: ["count"],
  cli_hint: ["command"],
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
const SAME_AS_ENGLISH: Record<string, string> = {};

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

  it("puts a left-to-right mark before [y/N] in the Arabic prompts", () => {
    expect(ar["uninstall.confirm_plan"]).toContain("‎[y/N] ");
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
    it("leaves an ordinary command line unchanged", () => {
      const line = "/usr/bin/node /app/dist/cli.js start --port 4096 --verbose";

      expect(redactCommandLine(line)).toBe(line);
    });

    it("redacts the value of --name value", () => {
      expect(redactCommandLine("opencode serve --api-token abc123 --port 4096")).toBe(
        "opencode serve --api-token *** --port 4096",
      );
    });

    it("redacts the value of --name=value", () => {
      expect(redactCommandLine("bot --password=hunter2 --port 1")).toBe(
        "bot --password=*** --port 1",
      );
    });

    it("redacts NAME=value assignments", () => {
      expect(redactCommandLine("TELEGRAM_BOT_TOKEN=123:abc node dist/index.js")).toBe(
        "TELEGRAM_BOT_TOKEN=*** node dist/index.js",
      );
      expect(redactCommandLine("env MY_SECRET=x API_KEY=y node a.js")).toBe(
        "env MY_SECRET=*** API_KEY=*** node a.js",
      );
    });

    it("redacts quoted values with spaces", () => {
      expect(redactCommandLine('bot --secret "two words" --port 1')).toBe(
        "bot --secret *** --port 1",
      );
      expect(redactCommandLine("bot PASSWD='a b' x")).toBe("bot PASSWD=*** x");
    });

    it("redacts an Authorization header value", () => {
      expect(redactCommandLine("tool -H Authorization: Bearer abc.def")).toBe(
        "tool -H Authorization: Bearer ***",
      );
    });

    it("redacts URL userinfo", () => {
      expect(redactCommandLine("node a.js --url https://user:pa55@host:8080/path")).toBe(
        "node a.js --url https://***@host:8080/path",
      );
    });

    it("never leaves a secret value in the output", () => {
      const out = redactCommandLine("x --credential s3cr3t AUTH=s3cr3t --key=s3cr3t");

      expect(out).not.toContain("s3cr3t");
    });
  });
});
