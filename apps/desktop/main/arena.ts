import { randomUUID } from 'node:crypto';
import { runMatch, type Controller, type GameAction, type GameDef, type GameView, type MatchEvent, type Seat } from '@gametable/engine';
import { LlmController, type CompletionClient } from '@gametable/agent';
import { ResultsStore, toRecord } from '@gametable/stats';
import type {
  ArenaConfig,
  ArenaProgress,
  ArenaResult,
  ReplayBundle,
} from '../shared/api.js';

/** A controller that waits while the arena is paused and dies on cancel. */
class Pausable implements Controller {
  constructor(
    private readonly inner: Controller,
    private readonly arena: ArenaRunner,
    private readonly signal: AbortSignal,
  ) {}

  get kind() {
    return this.inner.kind;
  }

  usage() {
    return this.inner.usage?.() ?? {};
  }

  async act(req: Parameters<Controller['act']>[0]): Promise<GameAction> {
    await this.arena.waitWhilePaused(this.signal);
    return this.inner.act(req);
  }
}

export interface ArenaDeps {
  games: Array<GameDef<any>>;
  client: CompletionClient;
  store: ResultsStore;
  saveBundle: (bundle: ReplayBundle) => Promise<void>;
  emit: (progress: ArenaProgress) => void;
}

export class ArenaRunner {
  private config: ArenaConfig | null = null;
  private progress: ArenaProgress = ArenaRunner.idle();
  private paused = false;
  private abort = new AbortController();
  private running = false;

  constructor(private readonly deps: ArenaDeps) {}

  static idle(): ArenaProgress {
    return {
      running: false,
      paused: false,
      index: 0,
      total: 0,
      costUsd: 0,
      totalBudgetUsd: 0,
      results: [],
    };
  }

  state(): ArenaProgress {
    return this.progress;
  }

  async waitWhilePaused(signal: AbortSignal): Promise<void> {
    while (this.paused && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (signal.aborted) throw new Error('arena cancelled');
  }

  pause(paused: boolean): void {
    this.paused = paused;
    this.progress = { ...this.progress, paused };
    this.deps.emit(this.progress);
  }

  cancel(): void {
    this.abort.abort();
  }

  async start(config: ArenaConfig): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: false, error: 'An arena run is already going.' };
    const def = this.deps.games.find((game) => game.id === config.gameId);
    if (!def) return { ok: false, error: `unknown game: ${config.gameId}` };
    if (config.matches < 1 || config.matches > 200) {
      return { ok: false, error: 'Run between 1 and 200 matches.' };
    }
    const usable = config.seats.filter((seat) => seat.modelId);
    if (def.maxSeats === 2) {
      if (usable.length < 2) return { ok: false, error: 'A duel needs at least two models.' };
    } else if (usable.length < def.minSeats || usable.length > def.maxSeats) {
      return {
        ok: false,
        error: `${def.name} needs ${def.minSeats}–${def.maxSeats} models, you have ${usable.length}.`,
      };
    }

    this.config = config;
    this.running = true;
    this.paused = false;
    this.abort = new AbortController();
    this.progress = {
      running: true,
      paused: false,
      index: 0,
      total: config.matches,
      costUsd: 0,
      totalBudgetUsd: config.totalBudgetUsd,
      results: [],
    };
    this.deps.emit(this.progress);

    void this.loop(def).finally(() => {
      this.running = false;
    });
    return { ok: true };
  }

  private async loop(def: GameDef<any>): Promise<void> {
    const config = this.config as ArenaConfig;
    for (let index = 0; index < config.matches; index++) {
      if (this.abort.signal.aborted) break;
      if (this.progress.costUsd >= config.totalBudgetUsd) {
        this.progress = {
          ...this.progress,
          running: false,
          error: `Stopped: the $${config.totalBudgetUsd.toFixed(2)} arena budget was reached.`,
        };
        this.deps.emit(this.progress);
        return;
      }

      const lineup = rotate(config.seats, index);
      const seats = this.seatsFor(def, lineup, index);
      const matchId = `a-${randomUUID().slice(0, 8)}`;
      const seed = config.seedBase + index;
      this.progress = {
        ...this.progress,
        index,
        currentGame: def.name,
        currentSeats: seats.map((seat) => seat.name),
      };
      this.deps.emit(this.progress);

      const controllers = new Map<string, Controller>();
      for (const seat of seats) {
        const inner = new LlmController({
          client: this.deps.client,
          gameName: def.name,
          config: { model: seat.modelId as string, temperature: 0.9 },
        });
        controllers.set(seat.id, new Pausable(inner, this, this.abort.signal));
      }

      const godViews: GameView[] = [];
      const events: MatchEvent[] = [];
      try {
        const result = await runMatch(def, seats, controllers, {
          matchId,
          seed,
          signal: this.abort.signal,
          maxActions: 4000,
          actionTimeoutMs: 60_000,
          maxInvalidActions: 3,
          options: {
            trackOptimality: def.capabilities.solver,
            discussionRounds: 1,
          },
          onEvent: (event, state) => {
            events.push(event);
            godViews.push(def.godView?.(state) ?? def.view(state, seats[0]?.id as string));
            if (events.length % 8 === 0) {
              this.progress = { ...this.progress, currentPhase: def.phase(state).label };
              this.deps.emit(this.progress);
            }
          },
        });

        const cost = result.seats.reduce((sum, seat) => sum + seat.usage.costUsd, 0);
        const names = new Map(result.seats.map((seat) => [seat.seatId, seat.name]));
        const summary = {
          matchId: result.matchId,
          gameId: result.gameId,
          gameName: def.name,
          startedAt: result.startedAt,
          durationMs: result.durationMs,
          winners: result.winners,
          winnerNames: result.winners.map((id) => names.get(id) ?? id),
          seats: result.seats.map((seat) => ({
            seatId: seat.seatId,
            name: seat.name,
            kind: seat.kind,
            modelId: seat.modelId,
            role: seat.role,
            costUsd: seat.usage.costUsd,
            tokensIn: seat.usage.tokensIn,
            tokensOut: seat.usage.tokensOut,
            invalidActions: seat.usage.invalidActions,
            errors: seat.usage.errors ?? 0,
            metrics: seat.metrics,
          })),
          totalCostUsd: cost,
          eventCount: result.events.length,
          metrics: result.metrics,
        };

        await this.deps.store.append(toRecord(result));
        await this.deps.saveBundle({
          summary,
          seats,
          seed,
          events,
          views: godViews,
          godViews,
        });

        const entry: ArenaResult = {
          matchId: result.matchId,
          gameName: def.name,
          winnerNames: summary.winnerNames,
          costUsd: cost,
          eventCount: result.events.length,
          seats: summary.seats.map((seat) => ({
            name: seat.name,
            modelId: seat.modelId,
            role: seat.role,
          })),
        };
        this.progress = {
          ...this.progress,
          index: index + 1,
          costUsd: this.progress.costUsd + cost,
          results: [...this.progress.results, entry],
          currentPhase: undefined,
        };
        this.deps.emit(this.progress);
      } catch (error) {
        if (this.abort.signal.aborted) {
          this.progress = { ...this.progress, running: false, paused: false, error: 'Run cancelled.' };
        } else {
          this.progress = {
            ...this.progress,
            running: false,
            paused: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        this.deps.emit(this.progress);
        return;
      }
    }

    this.progress = { ...this.progress, running: false, paused: false, finishedAt: Date.now() };
    this.deps.emit(this.progress);
  }

  private seatsFor(def: GameDef<any>, lineup: ArenaConfig['seats'], index: number): Seat[] {
    if (def.maxSeats === 2) {
      // Duels: rotate pairings so every model plays both sides.
      const first = lineup[index % lineup.length] as ArenaConfig['seats'][number];
      const second = lineup[(index + 1) % lineup.length] as ArenaConfig['seats'][number];
      return [first, second].map((entry, seatIndex) => ({
        id: `s${seatIndex + 1}`,
        name: entry.name,
        kind: 'llm',
        modelId: entry.modelId,
      }));
    }
    return lineup.map((entry, seatIndex) => ({
      id: `s${seatIndex + 1}`,
      name: entry.name,
      kind: 'llm',
      modelId: entry.modelId,
    }));
  }
}

function rotate<T>(items: T[], by: number): T[] {
  if (items.length === 0) return items;
  const offset = by % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}
