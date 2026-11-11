const SERVICE_CHILD_ENV_KEY = "OPENCODE_TELEGRAM_SERVICE_CHILD";
const SERVICE_STATE_PATH_ENV_KEY = "OPENCODE_TELEGRAM_SERVICE_STATE_PATH";
const SERVICE_LOGS_DIR_ENV_KEY = "OPENCODE_TELEGRAM_SERVICE_LOGS_DIR";

export function buildServiceChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  stateFilePath: string,
  logsDirPath: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [SERVICE_CHILD_ENV_KEY]: "1",
    [SERVICE_STATE_PATH_ENV_KEY]: stateFilePath,
    [SERVICE_LOGS_DIR_ENV_KEY]: logsDirPath,
  };
}

export function isServiceChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SERVICE_CHILD_ENV_KEY] === "1";
}

export function getServiceLogsDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[SERVICE_LOGS_DIR_ENV_KEY];
  if (!value || value.trim().length === 0) {
    return null;
  }

  return value;
}

export function getServiceStateFilePathFromEnv(): string | null {
  const value = process.env[SERVICE_STATE_PATH_ENV_KEY];
  if (!value || value.trim().length === 0) {
    return null;
  }

  return value;
}
