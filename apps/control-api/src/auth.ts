import { z } from 'zod';

const DevTokenMapSchema = z.record(z.string().min(1), z.string().min(1));
const ProductionTokenMapSchema = z.record(
  z.string().min(32),
  z.string().trim().min(1).max(128),
);
const RuntimeTokenMapSchema = z.record(
  z.string().min(32),
  z.object({
    userId: z.string().trim().min(1).max(128),
    podId: z.string().trim().min(1).max(128),
  }),
);

export interface CloudRuntimeIdentity {
  userId: string;
  podId: string;
}

export type RuntimeTokenAuthenticator = (
  authorizationHeader: string | undefined,
) => CloudRuntimeIdentity | null;

export interface DevAuthEnvironment {
  NODE_ENV?: string;
  CONTROL_DEV_TOKEN?: string;
  CONTROL_DEV_USER_ID?: string;
  CONTROL_DEV_TOKENS_JSON?: string;
}

export type DevTokenAuthenticator = (
  authorizationHeader: string | undefined,
) => string | null;

export function parseCloudRuntimeTokenMap(
  value: string | undefined,
): Record<string, CloudRuntimeIdentity> {
  if (!value) {
    throw new Error('CLOUD_RUNTIME_TOKENS_JSON is required');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('CLOUD_RUNTIME_TOKENS_JSON must contain valid JSON', {
      cause: error,
    });
  }

  const parsed = RuntimeTokenMapSchema.safeParse(raw);
  if (
    !parsed.success ||
    Object.keys(parsed.data ?? {}).length === 0 ||
    Object.keys(parsed.data ?? {}).some((token) => /\s/.test(token))
  ) {
    throw new Error(
      'CLOUD_RUNTIME_TOKENS_JSON must map tokens of at least 32 characters to non-empty userId and podId identities',
    );
  }
  return parsed.data;
}

export function createRuntimeTokenAuthenticator(
  env: { CLOUD_RUNTIME_TOKENS_JSON?: string },
): RuntimeTokenAuthenticator {
  const tokenToRuntime = parseCloudRuntimeTokenMap(
    env.CLOUD_RUNTIME_TOKENS_JSON,
  );
  return (authorizationHeader) => {
    const match = /^Bearer (.+)$/.exec(authorizationHeader ?? '');
    return match && Object.hasOwn(tokenToRuntime, match[1])
      ? tokenToRuntime[match[1]]
      : null;
  };
}

export function parseProductionTokenMap(
  value: string | undefined,
): Record<string, string> {
  if (!value) {
    throw new Error('CONTROL_TOKENS_JSON is required in production');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('CONTROL_TOKENS_JSON must contain valid JSON', {
      cause: error,
    });
  }

  const parsed = ProductionTokenMapSchema.safeParse(raw);
  if (
    !parsed.success ||
    Object.keys(parsed.data ?? {}).length === 0 ||
    Object.keys(parsed.data ?? {}).some((token) => /\s/.test(token))
  ) {
    throw new Error(
      'CONTROL_TOKENS_JSON must map tokens of at least 32 characters to non-empty user IDs',
    );
  }
  return parsed.data;
}

export function createTokenAuthenticator(
  env: DevAuthEnvironment & { CONTROL_TOKENS_JSON?: string },
): DevTokenAuthenticator {
  if (env.NODE_ENV !== 'production') {
    return createDevTokenAuthenticator(env);
  }

  const tokenToUser = parseProductionTokenMap(env.CONTROL_TOKENS_JSON);
  return (authorizationHeader) => {
    const match = /^Bearer (.+)$/i.exec(authorizationHeader ?? '');
    return match && Object.hasOwn(tokenToUser, match[1])
      ? tokenToUser[match[1]]
      : null;
  };
}

export function createDevTokenAuthenticator(
  env: DevAuthEnvironment,
): DevTokenAuthenticator {
  if (env.NODE_ENV === 'production') {
    throw new Error('Development token authentication is disabled in production');
  }

  let tokenToUser: Record<string, string>;
  if (env.CONTROL_DEV_TOKENS_JSON) {
    let raw: unknown;
    try {
      raw = JSON.parse(env.CONTROL_DEV_TOKENS_JSON) as unknown;
    } catch (error) {
      throw new Error('CONTROL_DEV_TOKENS_JSON must contain valid JSON', {
        cause: error,
      });
    }

    const parsed = DevTokenMapSchema.safeParse(raw);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      throw new Error(
        'CONTROL_DEV_TOKENS_JSON must map non-empty tokens to user IDs',
      );
    }
    tokenToUser = parsed.data;
  } else {
    tokenToUser = {
      [env.CONTROL_DEV_TOKEN ?? 'dev-token']:
        env.CONTROL_DEV_USER_ID ?? 'local-dev-user',
    };
  }

  return (authorizationHeader) => {
    const match = /^Bearer ([^\s]+)$/.exec(authorizationHeader ?? '');
    return match && Object.hasOwn(tokenToUser, match[1])
      ? tokenToUser[match[1]]
      : null;
  };
}
