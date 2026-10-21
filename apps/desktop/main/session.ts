import { randomUUID } from 'node:crypto';
import {
  runMatch,
  type ActionRequest,
  type Controller,
  type GameAction,
  type GameDef,
  type GameView,
  type MatchEvent,
  type MatchResult,
  type Seat,
  type SeatId,
} from '@gametable/engine';
import { LlmController, type CompletionClient, type LlmSeatConfig } from '@gametable/agent';
import { ResultsStore, toRecord } from '@gametable/stats';
import type {
  MatchSummary,
  ReplayBundle,
  SeatIssue,
  StartMatchRequest,
  TableSnapshot,
} from '../shared/api.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Paces AI seats and implements pause. The human seat is never gated: when it
 * is your turn, the table waits for you regardless of the speed setting.
 */
class Gate {
  paused = false;
  speed = 1;
  private waiting: Array<() => void> = [];

  async wait(): Promise<void> {
    if (this.paused) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    if (this.speed >= 6) return;
    await delay(Math.round(700 / this.speed));
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.waiting.splice(0).forEach((resolve) => resolve());
  }
}

class PacedController implements Controller {
  constructor(
    private readonly inner: Controller,
    private readonly gate: Gate,
  ) {}

  get kind() {
    return this.inner.kind;
  }

  usage() {
    return this.inner.usage?.() ?? {};
  }

  async act(req: ActionRequest): Promise<GameAction> {
    await this.gate.wait();
    return this.inner.act(req);
  }
}

class HumanController implements Controller {
  readonly kind = 'human' as const;

  constructor(private readonly session: MatchSession) {}

  act(req: ActionRequest): Promise<GameAction> {
    return this.session.askHuman(req);
  }
}

export interface SessionDeps {
  def: GameDef<any>;
  seats: Seat[];
  request: StartMatchRequest;
  client: CompletionClient | null;
  store: ResultsStore;
  saveBundle: (bundle: ReplayBundle) => Promise<void>;
  send: (snapshot: TableSnapshot) => void;
  sendFinished: (summary: MatchSummary) => void;
  sendError: (message: string) => void;
}

export class MatchSession {
  readonly matchId = `m-${randomUUID().slice(0, 8)}`;

  private readonly gate = new Gate();
  private readonly abort = new AbortController();
  private readonly controllers = new Map<SeatId, Controller>();
  private readonly human: Seat | null;
  private readonly seed: number;
  private readonly startedAt = Date.now();

  private pendingHuman: ((action: GameAction) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private snapshots: GameView[] = [];
  private godSnapshots: GameView[] = [];
  private latest: { view: GameView; god: GameView | null } | null = null;
  private events: MatchEvent[] = [];
  private costUsd = 0;
  private status: TableSnapshot['status'] = 'running';
  private paused = false;
  private speed: number;
  private fatalError: string | null = null;
  private phaseKey = '';
  private phaseStartedAt = Date.now();
  private phaseLimitMs: number | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.human = deps.seats.find((seat) => seat.kind === 'human') ?? null;
    this.speed = deps.request.speed ?? 1;
    this.gate.speed = this.speed;
    this.seed = deps.request.seed ?? Math.floor(Math.random() * 1e9);
  }

  async start(): Promise<void> {
    try {
      this.buildControllers();
      const initial = this.deps.def.setup({
        seed: this.seed,
        seats: this.deps.seats,
        options: this.gameOptions(),
      });
      this.capture(initial);
      this.push();

      const result = await runMatch(this.deps.def, this.deps.seats, this.controllers, {
        matchId: this.matchId,
        seed: this.seed,
        signal: this.abort.signal,
        actionTimeoutMs: 30 * 60 * 1000,
        maxInvalidActions: 3,
        maxActions: 4_000,
        options: this.gameOptions(),
        onEvent: (event, state) => this.onEvent(event, state),
      });
      this.events = result.events;
      await this.finish(result);
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.status = 'aborted';
        this.push();
        if (this.fatalError) this.deps.sendError(this.fatalError);
      } else {
        this.status = 'aborted';
        this.deps.sendError(error instanceof Error ? error.message : String(error));
        this.push();
      }
    }
  }

  askHuman(req: ActionRequest): Promise<GameAction> {
    this.latest = { view: req.view, god: null };
    this.status = 'running';
    return new Promise<GameAction>((resolve, reject) => {
      this.pendingHuman = resolve;
      this.pendingReject = reject;
      // Push *after* the pending action exists, so the UI knows it is your turn.
      this.push();
    });
  }

  submit(action: GameAction): void {
    const resolve = this.pendingHuman;
    this.pendingHuman = null;
    this.pendingReject = null;
    this.push();
    resolve?.(action);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.gate.setPaused(paused);
    this.push();
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.5, Math.min(8, speed));
    this.gate.speed = this.speed;
    this.push();
  }

  abortMatch(): void {
    this.status = 'aborted';
    this.abort.abort();
    this.pendingReject?.(new Error('aborted'));
    this.pendingHuman = null;
    this.pendingReject = null;
    this.push();
  }

  private gameOptions(): Record<string, unknown> {
    return {
      trackOptimality: this.deps.request.trackOptimality === true,
      discussionRounds: 1,
    };
  }

  private buildControllers(): void {
    for (const seat of this.deps.seats) {
      if (seat.kind === 'human') {
        this.controllers.set(seat.id, new HumanController(this));
        continue;
      }
      if (!this.deps.client) {
        throw new Error('No OpenRouter key is configured for the AI seats');
      }
      const config: LlmSeatConfig = {
        model: seat.modelId ?? '',
        temperature: 0.85,
        ...(seat.persona ? { persona: seat.persona } : {}),
      };
      const controller = new LlmController({
        client: this.deps.client,
        gameName: this.deps.def.name,
        config,
      });
      this.controllers.set(seat.id, new PacedController(controller, this.gate));
    }
  }

  private onEvent(event: MatchEvent, state: unknown): void {
    this.events.push(event);
    this.capture(state);
    this.push();

    if (this.costUsd > this.deps.request.budgetUsd) {
      this.fatalError = `Match budget of $${this.deps.request.budgetUsd.toFixed(2)} reached.`;
      this.abortMatch();
      return;
    }

    // If every model seat is failing, a "match" would just be fallback moves.
    const issues = this.seatIssues();
    const modelSeats = this.deps.seats.filter((seat) => seat.kind === 'llm').length;
    if (
      modelSeats > 0 &&
      issues.length === modelSeats &&
      issues.every((issue) => issue.count >= 1)
    ) {
      this.fatalError =
        `Every model seat is failing, so the match was stopped. ` +
        `${issues[0]?.name}: ${issues[0]?.message}`;
      this.abortMatch();
    }
  }

  private seatIssues(): SeatIssue[] {
    const issues: SeatIssue[] = [];
    for (const seat of this.deps.seats) {
      if (seat.kind !== 'llm') continue;
      const usage = this.controllers.get(seat.id)?.usage?.();
      // A seat that recovered from a transient hiccup should not keep a
      // permanent red banner on the table.
      if (usage?.errors && !usage.recovered) {
        issues.push({
          seatId: seat.id,
          name: seat.name,
          message: usage.lastError ?? 'model call failed',
          count: usage.errors,
        });
      }
    }
    return issues;
  }

  private capture(state: unknown): void {
    const view: GameView = this.human
      ? this.deps.def.view(state, this.human.id)
      : (this.deps.def.godView?.(state) ??
        this.deps.def.view(state, this.deps.seats[0]?.id as SeatId));
    const god = this.deps.def.godView ? this.deps.def.godView(state) : null;

    const key = `${view.phase.id}:${view.phase.round ?? 0}`;
    if (key !== this.phaseKey) {
      this.phaseKey = key;
      this.phaseStartedAt = Date.now();
      this.phaseLimitMs = this.deps.def.phaseTimeoutMs?.(state) ?? null;
    }
    // If the phase moved on (for example a deadline fired), the human is no
    // longer being waited on.
    if (this.pendingHuman && view.legalActions.length === 0) {
      this.pendingHuman = null;
      this.pendingReject = null;
    }

    this.latest = { view, god };
    this.snapshots.push(view);
    this.godSnapshots.push(god ?? view);
    this.refreshCost();
  }

  private refreshCost(): void {
    let total = 0;
    for (const controller of this.controllers.values()) {
      total += controller.usage?.().costUsd ?? 0;
    }
    this.costUsd = total;
  }

  private push(): void {
    if (!this.latest) return;
    this.deps.send({
      matchId: this.matchId,
      gameId: this.deps.def.id,
      gameName: this.deps.def.name,
      spectator: this.human === null,
      status: this.status,
      view: this.latest.view,
      godView: this.latest.god,
      humanSeatId: this.human?.id ?? null,
      awaitingHuman: this.pendingHuman !== null,
      seatIssues: this.seatIssues(),
      timeLeftMs:
        this.phaseLimitMs === null
          ? null
          : Math.max(0, this.phaseLimitMs - (Date.now() - this.phaseStartedAt)),
      costUsd: Number(this.costUsd.toFixed(6)),
      eventCount: this.events.length,
      paused: this.paused,
      speed: this.speed,
      budgetUsd: this.deps.request.budgetUsd,
    });
  }

  private async finish(result: MatchResult): Promise<void> {
    this.status = 'finished';
    this.refreshCost();
    this.push();

    const summary = this.summarise(result);
    this.deps.sendFinished(summary);

    try {
      const personas: Record<string, string> = {};
      for (const seat of this.deps.seats) {
        if (seat.persona) personas[seat.id] = seat.persona;
      }
      await this.deps.store.append(toRecord(result, personas));
      await this.deps.saveBundle({
        summary,
        seats: this.deps.seats,
        seed: this.seed,
        events: result.events,
        views: this.snapshots,
        godViews: this.godSnapshots,
      });
    } catch (error) {
      console.error('[session] could not persist match', error);
    }
  }

  private summarise(result: MatchResult): MatchSummary {
    const names = new Map(result.seats.map((seat) => [seat.seatId, seat.name]));
    return {
      matchId: result.matchId,
      gameId: result.gameId,
      gameName: this.deps.def.name,
      startedAt: this.startedAt,
      durationMs: Date.now() - this.startedAt,
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
      totalCostUsd: result.seats.reduce((sum, seat) => sum + seat.usage.costUsd, 0),
      eventCount: result.events.length,
      metrics: result.metrics,
    };
  }
}
