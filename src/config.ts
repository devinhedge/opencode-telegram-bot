import dotenv from "dotenv";
import { getRuntimePaths } from "./runtime/paths.js";
import { isContainerRuntime } from "./runtime/container.js";
import { persistEnvValue } from "./runtime/env-file.js";
import { BOT_HEALTH_PORT_ENV, resolveHealthPort } from "./runtime/health-port.js";
import { normalizeLocale, type Locale } from "./i18n/index.js";
import type { SecretStore } from "./secrets/secret-store.js";
import { verifyIntegrity, storeIntegrityData } from "./secrets/integrity.js";
import { migrateSecretsIfNeeded } from "./secrets/migrate-secrets.js";
import { logger } from "./utils/logger.js";

const runtimePaths = getRuntimePaths();
dotenv.config({ path: runtimePaths.envFilePath, quiet: true });

export type MessageFormatMode = "raw" | "markdown";
export type TtsProvider = "openai" | "google" | "elevenlabs" | "edge";
export type SttRequestFormat = "multipart" | "json";

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(
      `Missing required environment variable: ${key} (expected in ${runtimePaths.envFilePath})`,
    );
  }
  return value || "";
}

function getOptionalPathListEnvVar(key: string, delimiter: string = ","): string[] {
  const value = getEnvVar(key, false);
  if (!value || value.trim() === "") {
    return [];
  }
  return value
    .split(delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function getOptionalPositiveIntEnvVar(key: string, defaultValue: number): number {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return parsedValue;
}

// Like getOptionalPositiveIntEnvVar, but also accepts 0 (used to disable a feature).
function getOptionalNonNegativeIntEnvVar(key: string, defaultValue: number): number {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    return defaultValue;
  }

  return parsedValue;
}

function getOptionalLocaleEnvVar(key: string, defaultValue: Locale): Locale {
  const value = getEnvVar(key, false);
  return normalizeLocale(value, defaultValue);
}

function getOptionalBooleanEnvVar(key: string, defaultValue: boolean): boolean {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export type OpencodeServerVersion = "v1" | "v2";
export type OpencodeServerMode = "service" | "standalone";

const DEFAULT_OPENCODE_API_URLS: Record<OpencodeServerVersion, string> = {
  v1: "http://localhost:4096",
  v2: "http://127.0.0.1:49374",
};

/**
 * V1 ignores the mode. On V2, empty means the registered background server.
 * A typo must not fall through to that path.
 */
export function resolveOpencodeServerMode(version: OpencodeServerVersion): OpencodeServerMode {
  if (version !== "v2") {
    return "service";
  }

  const raw = getEnvVar("OPENCODE_SERVER_MODE", false).trim().toLowerCase();
  if (!raw || raw === "service") {
    return "service";
  }
  if (raw === "standalone") {
    return "standalone";
  }

  throw new Error(
    "Invalid OPENCODE_SERVER_MODE. Expected service or standalone. " +
      "Refusing to start, because an unknown value must not enable the V2 background server.",
  );
}

/** Standalone never falls back to the V2 service port. */
export function resolveOpencodeApiUrl(
  version: OpencodeServerVersion,
  mode: OpencodeServerMode,
): string {
  const fromEnv = getEnvVar("OPENCODE_API_URL", false).trim();
  if (version === "v2" && mode === "standalone" && !fromEnv) {
    throw new Error(
      "OPENCODE_SERVER_MODE=standalone requires OPENCODE_API_URL. " +
        "Refusing to default to the V2 service port.",
    );
  }
  return fromEnv || DEFAULT_OPENCODE_API_URLS[version];
}

function getOptionalOpencodeServerVersionEnvVar(key: string): OpencodeServerVersion {
  const normalized = getEnvVar(key, false).trim().toLowerCase();
  return normalized === "v2" ? "v2" : "v1";
}

function getOptionalMessageFormatModeEnvVar(
  key: string,
  defaultValue: MessageFormatMode,
): MessageFormatMode {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "raw" || normalized === "markdown") {
    return normalized;
  }

  return defaultValue;
}

export function parseInitialSettingsPreset(): Record<string, unknown> {
  const raw = getEnvVar("INITIAL_SETTINGS_PRESET", false).trim();
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "INITIAL_SETTINGS_PRESET contains invalid JSON. Fix or unset the variable.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "INITIAL_SETTINGS_PRESET must be a JSON object.",
    );
  }
  return parsed as Record<string, unknown>;
}

const VALID_TTS_PROVIDERS: TtsProvider[] = ["openai", "google", "elevenlabs", "edge"];

function getOptionalTtsProviderEnvVar(key: string, defaultValue: TtsProvider): TtsProvider {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (VALID_TTS_PROVIDERS.includes(normalized as TtsProvider)) {
    return normalized as TtsProvider;
  }

  return defaultValue;
}

const VALID_STT_REQUEST_FORMATS: SttRequestFormat[] = ["multipart", "json"];

function getOptionalSttRequestFormatEnvVar(
  key: string,
  defaultValue: SttRequestFormat,
): SttRequestFormat {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (VALID_STT_REQUEST_FORMATS.includes(normalized as SttRequestFormat)) {
    return normalized as SttRequestFormat;
  }

  return defaultValue;
}

export function buildTelegramConfig(secrets?: {
  token?: string;
  allowedUserId?: string;
  proxySecret?: string;
}): {
  token: string;
  allowedUserId: number;
  proxyUrl: string;
  apiRoot: string;
  proxySecret: string;
  forceIpv4: boolean;
} {
  const proxyUrl = getEnvVar("TELEGRAM_PROXY_URL", false);
  // grammY rejects an apiRoot ending with `/`, so normalize once at config
  // load instead of leaking the concern into every consumer.
  const apiRoot = getEnvVar("TELEGRAM_API_ROOT", false).replace(/\/+$/, "");
  const forceIpv4 = getOptionalBooleanEnvVar("TELEGRAM_FORCE_IPV4", false);

  if (proxyUrl && apiRoot) {
    throw new Error(
      "TELEGRAM_PROXY_URL and TELEGRAM_API_ROOT are alternative connectivity modes and cannot be used together. " +
        "TELEGRAM_PROXY_URL tunnels TCP through a SOCKS/HTTP forward proxy; " +
        "TELEGRAM_API_ROOT routes API calls through an HTTPS reverse proxy. Pick one.",
    );
  }
  if (secrets?.proxySecret && !apiRoot) {
    throw new Error(
      "TELEGRAM_PROXY_SECRET requires TELEGRAM_API_ROOT to be set. " +
        "Without a custom API root, the secret header would be sent to api.telegram.org.",
    );
  }

  return {
    token: secrets?.token || getEnvVar("TELEGRAM_BOT_TOKEN", false) || "",
    allowedUserId: secrets?.allowedUserId ? parseInt(secrets.allowedUserId, 10) : parseInt(getEnvVar("TELEGRAM_ALLOWED_USER_ID", false) || "0", 10),
    proxyUrl,
    apiRoot,
    proxySecret: secrets?.proxySecret || getEnvVar("TELEGRAM_PROXY_SECRET", false) || "",
    forceIpv4,
  };
}

// opencodeServerVersion is detected at runtime (see detectOpencodeVersion)
let opencodeServerVersion: OpencodeServerVersion = getOptionalOpencodeServerVersionEnvVar("OPENCODE_SERVER_VERSION");

/** Detect the installed OpenCode version and return the API version (v1 or v2). */
export async function detectOpencodeVersion(): Promise<OpencodeServerVersion> {
  try {
    const { readLocalOpencodeVersion, getOpencodeApiVersion } = await import("./opencode/process.js");
    const versionString = await readLocalOpencodeVersion();
    if (versionString) {
      return getOpencodeApiVersion(versionString);
    }
  } catch {
    // Fall through to default
  }
  return opencodeServerVersion;
}

/** Persist the detected OpenCode version to .env atomically, keeping the file's mode. */
export async function persistOpencodeVersion(version: OpencodeServerVersion): Promise<void> {
  await persistEnvValue(runtimePaths.envFilePath, "OPENCODE_SERVER_VERSION", version);
}

/** Get the current detected opencode server version. */
export function getOpencodeServerVersion(): OpencodeServerVersion {
  return opencodeServerVersion;
}

/** Set the opencode server version (used during detection). */
export function setOpencodeServerVersion(version: OpencodeServerVersion): void {
  opencodeServerVersion = version;
}
const opencodeServerMode = resolveOpencodeServerMode(opencodeServerVersion);

const _config = {
  telegram: buildTelegramConfig({}),
  opencode: {
    serverVersion: opencodeServerVersion,
    serverMode: opencodeServerMode,
    apiUrl: resolveOpencodeApiUrl(opencodeServerVersion, opencodeServerMode),
    username: getEnvVar("OPENCODE_SERVER_USERNAME", false) || "opencode",
    password: getEnvVar("OPENCODE_SERVER_PASSWORD", false) || "",
    autoRestartEnabled: getOptionalBooleanEnvVar("OPENCODE_AUTO_RESTART_ENABLED", false),
    monitorIntervalSec: getOptionalPositiveIntEnvVar("OPENCODE_MONITOR_INTERVAL_SEC", 300),
    model: {
      provider: getEnvVar("OPENCODE_MODEL_PROVIDER", true), // Required
      modelId: getEnvVar("OPENCODE_MODEL_ID", true), // Required
    },
  },
  server: {
    logLevel: getEnvVar("LOG_LEVEL", false) || "info",
  },
  health: {
    port: resolveHealthPort(
      getEnvVar(BOT_HEALTH_PORT_ENV, false),
      isContainerRuntime(),
      getOptionalBooleanEnvVar("BOT_HEALTH_PORT_AUTO", true),
    ),
    autoScanEnabled: getOptionalBooleanEnvVar("BOT_HEALTH_PORT_AUTO", true),
  },
  bot: {
    sessionsListLimit: getOptionalPositiveIntEnvVar("SESSIONS_LIST_LIMIT", 10),
    messagesListLimit: getOptionalPositiveIntEnvVar("MESSAGES_LIST_LIMIT", 10),
    projectsListLimit: getOptionalPositiveIntEnvVar("PROJECTS_LIST_LIMIT", 10),
    commandsListLimit: getOptionalPositiveIntEnvVar("COMMANDS_LIST_LIMIT", 10),
    modelsListLimit: getOptionalPositiveIntEnvVar("MODELS_LIST_LIMIT", 10),
    taskLimit: getOptionalPositiveIntEnvVar("TASK_LIMIT", 10),
    scheduledTaskExecutionTimeoutMinutes: getOptionalPositiveIntEnvVar(
      "SCHEDULED_TASK_EXECUTION_TIMEOUT_MINUTES",
      120,
    ),
    scheduledTaskNotificationsSilent: getOptionalBooleanEnvVar(
      "SCHEDULED_TASK_DISABLE_NOTIFICATION",
      false,
    ),
    bashToolDisplayMaxLength: getOptionalPositiveIntEnvVar("BASH_TOOL_DISPLAY_MAX_LENGTH", 128),
    locale: getOptionalLocaleEnvVar("BOT_LOCALE", "en"),
    trackBackgroundSessions: getOptionalBooleanEnvVar("TRACK_BACKGROUND_SESSIONS", true),
    messageFormatMode: getOptionalMessageFormatModeEnvVar("MESSAGE_FORMAT_MODE", "markdown"),
    // Buffer near-limit text for this window so Telegram-split chunks can be merged.
    // Short messages are processed immediately; 0 disables merging entirely.
    messageMergeWindowMs: getOptionalNonNegativeIntEnvVar("MESSAGE_MERGE_WINDOW_MS", 1500),
    initialSettingsPreset: parseInitialSettingsPreset(),
    excludedProjectPaths: getOptionalPathListEnvVar("PROJECTS_EXCLUDED_PATHS"),
  },
  files: {
    maxFileSizeKb: parseInt(getEnvVar("CODE_FILE_MAX_SIZE_KB", false) || "100", 10),
  },
  restart: {
    gracePeriodSec: getOptionalPositiveIntEnvVar("RESTART_GRACE_PERIOD_SEC", 60),
  },
  open: {
    browserRoots: getEnvVar("OPEN_BROWSER_ROOTS", false),
  },
  stt: {
    apiUrl: getEnvVar("STT_API_URL", false),
    apiKey: getEnvVar("STT_API_KEY", false) || "",
    model: getEnvVar("STT_MODEL", false) || "whisper-large-v3-turbo",
    language: getEnvVar("STT_LANGUAGE", false),
    notePrompt: getEnvVar("STT_NOTE_PROMPT", false),
    // "multipart" (default) = standard OpenAI/Groq Whisper form-data upload.
    // "json" = base64 audio in an `input_audio` JSON body (e.g. OpenRouter).
    requestFormat: getOptionalSttRequestFormatEnvVar("STT_REQUEST_FORMAT", "multipart"),
  },
  docExtractor: {
    apiUrl: getEnvVar("DOC_EXTRACTOR_URL", false),
    apiKey: getEnvVar("DOC_EXTRACTOR_API_KEY", false) || "",
  },
  tts: (() => {
    const provider = getOptionalTtsProviderEnvVar("TTS_PROVIDER", "openai");
    const defaultVoice =
      provider === "google"
        ? "en-US-Studio-O"
        : provider === "elevenlabs"
          ? "21m00Tcm4TlvDq8ikWAM"
          : provider === "edge"
            ? "en-US-EmmaMultilingualNeural"
            : "alloy";
    const defaultModel =
      provider === "elevenlabs" ? "eleven_flash_v2_5" : "gpt-4o-mini-tts";
    return {
      apiUrl: getEnvVar("TTS_API_URL", false),
      apiKey: getEnvVar("TTS_API_KEY", false) || "",
      provider,
      model: getEnvVar("TTS_MODEL", false) || defaultModel,
      voice: getEnvVar("TTS_VOICE", false) || defaultVoice,
    };
  })(),
};


let _cachedConfig: typeof _config | null = null;

// Backward-compatible synchronous export. Populated at import time from .env;
// secrets are overlaid by loadConfig() when a SecretStore is provided.
export let config = _config;

const SECRET_ACCOUNTS = {
  telegramBotToken: "telegram_bot_token",
  telegramProxySecret: "telegram_proxy_secret",
  opencodeServerPassword: "opencode_server_password",
  sttApiKey: "stt_api_key",
  ttsApiKey: "tts_api_key",
  docExtractorApiKey: "doc_extractor_api_key",
  allowedUserId: "allowed_user_id",
} as const;

export async function loadConfig(secretStore?: SecretStore): Promise<typeof _config> {
  if (_cachedConfig) {
    config = _cachedConfig;
    return _cachedConfig;
  }

  // Auto-detect OpenCode version and override config
  const previousVersion = opencodeServerVersion;
  const detectedVersion = await detectOpencodeVersion();
  if (detectedVersion !== previousVersion) {
    logger.info(`[Config] OpenCode version changed: ${previousVersion} → ${detectedVersion} (auto-corrected)`);
  } else {
    logger.info(`[Config] Detected OpenCode ${detectedVersion}`);
  }
  setOpencodeServerVersion(detectedVersion);

  // Persist detected version to .env
  try {
    await persistOpencodeVersion(detectedVersion);
    logger.debug(`[Config] Persisted OPENCODE_SERVER_VERSION=${detectedVersion} to .env`);
  } catch (error) {
    logger.warn(`[Config] Failed to persist OpenCode version to .env: ${error}`);
  }

  // Create a secret store if one wasn't provided
  if (!secretStore) {
    try {
      const { createSecretStore } = await import("./secrets/secret-store-factory.js");
      secretStore = await createSecretStore({ appHome: runtimePaths.appHome });
    } catch {
      // No secret store available, continue with .env values
      secretStore = undefined;
    }
  }

  // Run migration from .env to secret store if secrets exist in .env
  if (secretStore) {
    await migrateSecretsIfNeeded(secretStore, runtimePaths.envFilePath);
  }

  const baseConfig = { ..._config };

  // Override serverVersion and related fields based on detected version
  baseConfig.opencode.serverVersion = opencodeServerVersion;
  baseConfig.opencode.serverMode = resolveOpencodeServerMode(opencodeServerVersion);
  baseConfig.opencode.apiUrl = resolveOpencodeApiUrl(opencodeServerVersion, baseConfig.opencode.serverMode);

  if (secretStore) {
    const secrets: Record<string, string | null> = {};

    for (const [key, account] of Object.entries(SECRET_ACCOUNTS)) {
      try {
        secrets[key] = await secretStore.getSecret(account);
      } catch {
        secrets[key] = null;
      }
    }

    if (secrets.telegramBotToken) {
      baseConfig.telegram.token = secrets.telegramBotToken;
    }
    if (secrets.telegramProxySecret) {
      baseConfig.telegram.proxySecret = secrets.telegramProxySecret;
    }
    if (secrets.opencodeServerPassword) {
      baseConfig.opencode.password = secrets.opencodeServerPassword;
    }
    if (secrets.sttApiKey) {
      baseConfig.stt.apiKey = secrets.sttApiKey;
    }
    if (secrets.ttsApiKey) {
      baseConfig.tts.apiKey = secrets.ttsApiKey;
    }
    if (secrets.docExtractorApiKey) {
      baseConfig.docExtractor.apiKey = secrets.docExtractorApiKey;
    }
    if (secrets.allowedUserId) {
      baseConfig.telegram.allowedUserId = parseInt(secrets.allowedUserId, 10);
    }

    // Verify integrity of loaded secrets
    const envValues: Record<string, string | undefined> = {
      telegramBotToken: baseConfig.telegram.token,
      telegramProxySecret: baseConfig.telegram.proxySecret || undefined,
      opencodeServerPassword: baseConfig.opencode.password || undefined,
      sttApiKey: baseConfig.stt.apiKey || undefined,
      ttsApiKey: baseConfig.tts.apiKey || undefined,
      docExtractorApiKey: baseConfig.docExtractor.apiKey || undefined,
      allowedUserId: String(baseConfig.telegram.allowedUserId),
    };

    await verifyIntegrity(secretStore, envValues);

    // Store/update integrity data for future verification
    await storeIntegrityData(secretStore, envValues);
  }

  _cachedConfig = baseConfig;
  config = baseConfig;
  return _cachedConfig;
}
