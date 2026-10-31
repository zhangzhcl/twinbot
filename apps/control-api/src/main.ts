import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import { AgentWorker } from './agentWorker';
import {
  createRuntimeTokenAuthenticator,
  createTokenAuthenticator,
} from './auth';
import { loadConfig } from './config';
import { PostgresConversationStore } from './postgresConversationStore';
import { PiAgentEngine } from './piAgent';
import { createControlServer } from './server';
import { LocalToolRouter } from './toolRouter';
import { RoutineScheduler } from './routineScheduler';

async function main(): Promise<void> {
  const envFile = process.env.TWINBOT_CONFIG_FILE ??
    path.resolve(__dirname, '../../../.env');
  const loaded = dotenv.config({ path: envFile });
  if (loaded.error) {
    throw new Error(`Unable to load configuration file: ${envFile}`, {
      cause: loaded.error,
    });
  }
  const config = loadConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = new PostgresConversationStore(pool);
  const authenticate = createTokenAuthenticator({
    NODE_ENV: config.nodeEnv,
    CONTROL_DEV_TOKENS_JSON: config.nodeEnv === 'production'
      ? undefined
      : JSON.stringify(config.tokenUsers),
    CONTROL_TOKENS_JSON: config.nodeEnv === 'production'
      ? JSON.stringify(config.tokenUsers)
      : undefined,
  });
  const authenticateRuntime = Object.keys(config.runtimeTokenUsers).length > 0
    ? createRuntimeTokenAuthenticator({
        CLOUD_RUNTIME_TOKENS_JSON: JSON.stringify(config.runtimeTokenUsers),
      })
    : undefined;

  try {
    await store.migrate();
    const interruptedToolCalls = await store.failInterruptedToolCalls();
    if (interruptedToolCalls > 0) {
      console.warn(
        `[control-api] marked ${interruptedToolCalls} interrupted tool call(s) as failed`,
      );
    }
    const toolRouter = new LocalToolRouter(store);
    const shouldRunWorker = (config.serverRole === 'all' || config.serverRole === 'worker') &&
      Boolean(config.agentApiKey && config.agentModel);
    const shouldRunServer = config.serverRole === 'all' || config.serverRole === 'gateway';

    const publishSessionDelta = (
      userId: string,
      sessionId: string,
      delta: unknown,
    ): void => {
      toolRouter.publishSessionDelta(userId, sessionId, delta);
    };

    const routineScheduler = shouldRunWorker || shouldRunServer
      ? new RoutineScheduler({
          store,
          publishSessionDelta,
          pollIntervalMs: 15_000,
        })
      : null;

    const worker = shouldRunWorker
      ? new AgentWorker({
          store,
          engine: new PiAgentEngine({
            provider: config.agentProvider,
            apiBaseUrl: config.agentApiBaseUrl ?? 'https://api.openai.com/v1',
            apiKey: config.agentApiKey!,
            model: config.agentModel!,
            timeoutMs: config.agentTimeoutMs,
            getUserModelConfig: (userId) => store.getUserModelConfig(userId),
            getUserMemories: async (userId) => store.listMemories(userId),
            memoryStore: store,
            toolRouter,
          }),
          concurrency: config.agentConcurrency,
          leaseMs: config.agentTimeoutMs + 30_000,
          publishSessionDelta,
        })
      : null;
    const server = shouldRunServer
      ? createControlServer({
          store,
          authenticate,
          authenticateRuntime,
          toolRouter,
          cancelRun: (runId) => worker?.cancelRun(runId) ?? false,
          previewPublicBaseUrl: config.previewPublicBaseUrl,
          onSessionCreated: async (userId, sessionId) => {
            await routineScheduler?.notifyEvent(userId, 'session.created', { sessionId });
          },
        })
      : null;
    const { host, port } = config;

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      console.log(`[control-api] listening on ${host}:${port} (role=${config.serverRole})`);
    }

    if (worker) {
      worker.start();
      console.log(`[control-api] agent worker started (concurrency=${config.agentConcurrency})`);
    } else if (config.serverRole !== 'gateway') {
      console.warn('[control-api] agent worker disabled; configure AGENT_API_KEY and AGENT_MODEL');
    }

    if (routineScheduler) {
      routineScheduler.start();
      console.log('[control-api] routine scheduler started');
    }

    const shutdown = (): void => {
      void (async () => {
        await routineScheduler?.stop();
        await worker?.stop();
        if (server) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          });
        }
        await pool.end();
      })().catch((error: unknown) => {
        console.error(
          '[control-api] shutdown failed:',
          error instanceof Error ? error.message : 'unknown error',
        );
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(
    '[control-api] startup failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
