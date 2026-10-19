/**
 * The interface-sufficiency half of the M2c gate.
 *
 * Correctness tests pass even when an abstraction is shaped around one game.
 * These checks catch the other failure modes: declared UI capabilities that do
 * not cover what the app must render, and a gateway that only works for one
 * game's action shapes.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { runMatch, type GameDef, type MatchResult, type Seat } from '@gametable/engine';
import { createLlmControllers } from '@gametable/agent';
import { ResultsStore, bradleyTerry, toRecord, type MatchRecord } from '@gametable/stats';
import { FakeModelClient } from './fake-model.js';

/** Panels the generic M3 renderer always draws. */
export const REQUIRED_PANELS = ['seat-ring', 'phase-banner', 'action-panel'] as const;

/** Capabilities that force an extra panel. */
export const CAPABILITY_PANELS: Record<string, string> = {
  chat: 'chat',
  health: 'health-bar',
  items: 'item-belt',
};

export function auditCapabilities<S>(def: GameDef<S>): string[] {
  const issues: string[] = [];
  const caps = def.capabilities;

  if (def.minSeats < 2) issues.push('minSeats must be at least 2');
  if (def.maxSeats > 11) issues.push('maxSeats must be at most 11 (one human plus ten models)');
  if (def.minSeats > def.maxSeats) issues.push('minSeats is greater than maxSeats');
  if (!def.id.match(/^[a-z0-9]+(\.[a-z0-9]+)*$/)) issues.push(`game id "${def.id}" is not namespaced`);

  for (const panel of REQUIRED_PANELS) {
    if (!caps.uiPanels.includes(panel)) issues.push(`missing required uiPanel "${panel}"`);
  }
  for (const [capability, panel] of Object.entries(CAPABILITY_PANELS)) {
    const enabled = (caps as unknown as Record<string, unknown>)[capability] === true;
    if (enabled && !caps.uiPanels.includes(panel)) {
      issues.push(`capability "${capability}" needs uiPanel "${panel}"`);
    }
  }
  if (new Set(caps.uiPanels).size !== caps.uiPanels.length) {
    issues.push('duplicate uiPanels');
  }
  if (caps.solver && typeof def.metricsFor !== 'function') {
    issues.push('solver capability requires metricsFor() so the leaderboard can use it');
  }
  if (caps.simultaneousPhases && def.maxSeats < 5) {
    issues.push('simultaneous phases only make sense for multiplayer games');
  }
  return issues;
}

export interface GatewayRoundTrip {
  result: MatchResult;
  calls: number;
  fallbacks: number;
  invalidActions: number;
}

/**
 * Plays a whole match where every seat is a real `LlmController` talking to a
 * fake transport. Any mismatch between the schema, the prompt parser and the
 * engine's legality check shows up as a fallback.
 */
export async function runGatewayRoundTrip<S>(
  def: GameDef<S>,
  options: { seatCount?: number; seed?: number; maxActions?: number } = {},
): Promise<GatewayRoundTrip> {
  const count = options.seatCount ?? def.minSeats;
  const seats: Seat[] = Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    name: `Model ${i + 1}`,
    kind: 'llm' as const,
    modelId: `fake/model-${i + 1}`,
  }));
  const client = new FakeModelClient();
  const configs = new Map(
    seats.map((seat) => [seat.id, { model: seat.modelId as string, temperature: 0.5 }]),
  );
  const controllers = createLlmControllers(seats, configs, client, def.name);
  const result = await runMatch(def, seats, controllers, {
    seed: options.seed ?? 7,
    maxActions: options.maxActions ?? 3_000,
    actionTimeoutMs: 5_000,
  });
  return {
    result,
    calls: client.calls,
    fallbacks: result.seats.reduce((sum, seat) => sum + seat.usage.fallbacks, 0),
    invalidActions: result.seats.reduce((sum, seat) => sum + seat.usage.invalidActions, 0),
  };
}

/** Results record → JSONL store → ratings, exactly as the app will use it. */
export async function runPipelineCheck<S>(def: GameDef<S>): Promise<{
  records: MatchRecord[];
  ratings: ReturnType<typeof bradleyTerry>;
}> {
  const { result } = await runGatewayRoundTrip(def);
  const record = toRecord(result);
  const file = join(tmpdir(), `gametable-gate-${process.pid}-${def.id}-${Date.now()}.jsonl`);
  const store = new ResultsStore(file);
  try {
    await store.append(record);
    const records = await store.all();
    if (records.length !== 1) throw new Error(`expected 1 stored record, got ${records.length}`);
    const back = records[0] as MatchRecord;
    if (JSON.stringify(back) !== JSON.stringify(record)) {
      throw new Error('stored record does not round-trip');
    }
    return { records, ratings: bradleyTerry(records) };
  } finally {
    await unlink(file).catch(() => undefined);
  }
}
