import { ChaosEngine, FileSpoolTransport, loadManifest, type Logger } from '@chaos-engine/core';

import { resolveSpoolDir, type BotConfig } from './config.js';

/**
 * Builds the engine the bot talks to. This is the only place in the bot that
 * knows a transport exists; swapping the file spool for a socket transport
 * later is a one-line change here.
 */
export async function createEngine(cfg: BotConfig, logger: Logger): Promise<ChaosEngine> {
  const dir = resolveSpoolDir(cfg);
  const manifest = cfg.game.manifest ? await loadManifest(cfg.game.manifest) : null;

  const engine = new ChaosEngine({
    transport: new FileSpoolTransport({ dir, logger }),
    manifest,
    logger,
    globalCooldownSeconds: cfg.game.globalCooldownSeconds,
    avoidRepeatsFor: cfg.vote.avoidRepeatsFor,
  });

  logger.info(`game spool: ${dir}`);
  return engine;
}
