import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createLogger } from '@chaos-engine/core';

import { ChaosBot } from './bot.js';
import { loadConfig } from './config.js';
import { createEngine } from './game-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? path.join(here, '..', 'config.json');

async function main(): Promise<void> {
  const cfg = await loadConfig(configPath);
  const logger = createLogger('bot', cfg.logLevel);
  // Never the token itself, only where it came from -- an environment variable
  // silently overriding the config file is otherwise invisible.
  logger.info(`token from ${cfg.tokenSource}`);

  const engine = await createEngine(cfg, logger);
  await engine.start();

  const bot = new ChaosBot(cfg, engine, logger, configPath);
  await bot.start();

  const shutdown = async (signal: string) => {
    logger.info(`${signal}, shutting down`);
    await bot.stop();
    await engine.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
