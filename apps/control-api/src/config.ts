import {
  parseCloudRuntimeTokenMap,
  parseProductionTokenMap,
  type CloudRuntimeIdentity,
} from './auth';

export type ServerRole = 'all' | 'gateway' | 'worker';

export interface ControlApiConfig {
  nodeEnv: string;
  serverRole: ServerRole;
  databaseUrl: string;
  tokenUsers: Record<string, string>;
  runtimeTokenUsers: Record<string, CloudRuntimeIdentity>;
  host: string;
  port: number;
  agentConcurrency: number;
  agentTimeoutMs: number;
  agentProvider: string;
  agentApiBaseUrl?: string;
  agentApiKey?: string;
  agentModel?: string;
  /** 产物预览的公网访问基础地址（如 https://your-domain:8787），/p/<token> 路由拼在其后 */
  previewPublicBaseUrl: string;
}

export type Environment = Record<string, string | undefined>;

function parseInteger(
  env: Environment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseDevTokens(env: Environment): Record<string, string> {
  if (env.CONTROL_DEV_TOKENS_JSON) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.CONTROL_DEV_TOKENS_JSON) as unknown;
    } catch (error) {
      throw new Error('CONTROL_DEV_TOKENS_JSON must contain valid JSON', {
        cause: error,
      });
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length === 0 ||
      Object.entries(parsed).some(
        ([token, userId]) =>
          token.length === 0 ||
          typeof userId !== 'string' ||
          userId.trim().length === 0,
      )
    ) {
      throw new Error(
        'CONTROL_DEV_TOKENS_JSON must map non-empty tokens to user IDs',
      );
    }
    return parsed as Record<string, string>;
  }

  return {
    [env.CONTROL_DEV_TOKEN ?? 'dev-token']:
      env.CONTROL_DEV_USER_ID ?? 'local-dev-user',
  };
}

function parseServerRole(env: Environment): ServerRole {
  const role = env.SERVER_ROLE ?? 'all';
  if (role !== 'all' && role !== 'gateway' && role !== 'worker') {
    throw new Error('SERVER_ROLE must be one of: all, gateway, worker');
  }
  return role;
}

export function loadConfig(env: Environment): ControlApiConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const serverRole = parseServerRole(env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch (error) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL', {
      cause: error,
    });
  }
  if (
    parsedDatabaseUrl.protocol !== 'postgres:' &&
    parsedDatabaseUrl.protocol !== 'postgresql:'
  ) {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }

  const agentApiKey = env.AGENT_API_KEY;
  const agentModel = env.AGENT_MODEL;
  if (Boolean(agentApiKey) !== Boolean(agentModel)) {
    throw new Error('AGENT_API_KEY and AGENT_MODEL must be configured together');
  }
  const agentApiBaseUrl = env.AGENT_API_BASE_URL ?? 'https://api.openai.com/v1';
  let parsedAgentApiBaseUrl: URL;
  try {
    parsedAgentApiBaseUrl = new URL(agentApiBaseUrl);
  } catch (error) {
    throw new Error('AGENT_API_BASE_URL must be a valid HTTPS URL', { cause: error });
  }
  if (parsedAgentApiBaseUrl.protocol !== 'https:' && parsedAgentApiBaseUrl.hostname !== 'localhost' && parsedAgentApiBaseUrl.hostname !== '127.0.0.1') {
    throw new Error('AGENT_API_BASE_URL must use HTTPS except for localhost');
  }

  return {
    nodeEnv,
    serverRole,
    databaseUrl,
    tokenUsers: nodeEnv === 'production'
      ? parseProductionTokenMap(env.CONTROL_TOKENS_JSON)
      : parseDevTokens(env),
    runtimeTokenUsers: env.CLOUD_RUNTIME_TOKENS_JSON
      ? parseCloudRuntimeTokenMap(env.CLOUD_RUNTIME_TOKENS_JSON)
      : {},
    host: env.CONTROL_HOST ?? '127.0.0.1',
    port: parseInteger(env, 'CONTROL_PORT', 8787, 1, 65535),
    agentConcurrency: parseInteger(env, 'AGENT_CONCURRENCY', 1, 1, 100),
    agentTimeoutMs: parseInteger(env, 'AGENT_TIMEOUT_MS', 120_000, 1_000, 600_000),
    agentProvider: env.AGENT_PROVIDER ?? 'openai-compatible',
    agentApiBaseUrl: agentModel ? agentApiBaseUrl.replace(/\/+$/, '') : undefined,
    agentApiKey,
    agentModel,
    previewPublicBaseUrl: (env.PREVIEW_PUBLIC_BASE_URL ?? `http://${env.CONTROL_HOST ?? '127.0.0.1'}:${env.CONTROL_PORT ?? '8787'}`).replace(/\/+$/, ''),
  };
}
