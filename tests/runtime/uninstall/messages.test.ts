import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { de } from "../../../src/i18n/de.js";
import { en, type I18nKey } from "../../../src/i18n/en.js";
import {
  createUninstallTranslator,
  resolveUninstallLocale,
} from "../../../src/runtime/uninstall/messages.js";

const REQUIRED_KEYS = [
  "refused_container",
  "refused_root",
  "plan_header",
  "plan_daemon",
  "plan_terminal_bots",
  "plan_systemd",
  "plan_home",
  "plan_override",
  "plan_keychain",
  "plan_logs_stay",
  "plan_opencode_server",
  "plan_nothing",
  "confirm_plan",
  "confirm_override",
  "confirm_stop_process",
  "confirm_stop_opencode",
  "confirm_stop_opencode_tree",
  "no_terminal_plan_only",
  "aborted",
  "step_daemon_stopped",
  "step_removed",
  "step_absent",
  "step_failed",
  "step_link_removed",
  "step_keychain",
  "step_keychain_unavailable",
  "step_systemd",
  "step_systemd_commands",
  "step_process_stopped",
  "step_process_failed",
  "step_process_skipped",
  "step_override_invalid",
  "step_override_skipped",
  "step_opencode_stopped",
  "step_opencode_skipped",
  "home_removed",
  "home_kept",
  "summary_ok",
  "summary_left",
  "summary_failed",
  "cli_hint",
  "override_reason_missing",
  "override_reason_unreadable",
  "override_reason_not_a_directory",
  "override_reason_root",
  "override_reason_user_home",
  "override_reason_no_bot_files",
  "keychain_status_removed",
  "keychain_status_absent",
  "keychain_status_failed",
  "systemd_outcome_removed",
  "systemd_outcome_absent",
  "systemd_outcome_not_applicable",
  "systemd_outcome_skipped_no_terminal",
  "systemd_outcome_skipped_no_sudo",
  "systemd_outcome_failed",
  "step_home_error",
  "step_scan_failed",
  "step_process_refused",
  "step_opencode_refused",
  "step_opencode_none",
  "step_target_left",
  "command_unavailable",
  "step_systemd_failed",
];

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

  it("defines every uninstall key in en", () => {
    for (const key of REQUIRED_KEYS) {
      expect(Object.hasOwn(en, `uninstall.${key}`), key).toBe(true);
    }
  });

  describe("resolveUninstallLocale", () => {
    it("prefers the real environment over the .env file", async () => {
      await fs.writeFile(envFilePath, "BOT_LOCALE=fr\n");

      await expect(resolveUninstallLocale({ BOT_LOCALE: "de" }, envFilePath)).resolves.toBe("de");
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

    it("never lets a key fall back unresolved", () => {
      const translate = createUninstallTranslator("de");

      for (const key of REQUIRED_KEYS) {
        const fullKey = `uninstall.${key}` as I18nKey;
        expect(translate(fullKey), key).not.toBe(fullKey);
      }
    });
  });
});
