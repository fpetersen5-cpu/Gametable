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
import {
  LlmController,
  type CompletionClient,
  type LlmSeatConfig,
  type LlmSeatState,
} from '@gametable/agent';
import { ResultsStore, toRecord } from '@gametable/stats';
import { generateDebrief } from './debrief.js';
import type {
  MatchSummary,
  ReplayBundle,
  SeatHealth,
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

/**
 * Races a controller against the run's abort signal, so a rewind or abort does
 * not have to wait for a slow model call to finish.
 */
class Abortable implements Controller {
  constructor(
    private readonly inner: Controller,
    private readonly signal: AbortSignal,
  ) {}

  get kind() {
    return this.inner.kind;
  }

  usage() {
    return this.inner.usage?.() ?? {};
  }

  act(req: ActionRequest): Promise<GameAction> {
    if (this.signal.aborted) return Promise.reject(new Error('aborted'));
    const stopped = new Promise<never>((_, reject) => {
      this.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return Promise.race([this.inner.act(req), stopped]);
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
  /** Default provider used when no per-seat resolver is given. */
  client: CompletionClient | null;
  /** Per-seat provider selection (OpenRouter vs. a local endpoint). */
  clientForSeat?: (seat: Seat) => CompletionClient | null;
  store: ResultsStore;
  saveBundle: (bundle: ReplayBundle) => Promise<void>;
  send: (snapshot: TableSnapshot) => void;
  /** Live, partial table talk from a seat; an empty string clears it. */
  sendPreview: (seatId: SeatId, text: string) => void;
  sendFinished: (summary: MatchSummary) => void;
  sendError: (message: string) => void;
  sendDebrief: (debrief: { matchId: string; text: string; model: string; costUsd: number }) => void;
  debriefModel: string | null;
  saveDebrief?: (
    matchId: string,
    debrief: { text: string; model: string; costUsd: number },
  ) => Promise<void>;
  saveLive?: (snapshot: {
    matchId: string;
    gameId: string;
    gameName: string;
    request: StartMatchRequest;
    seats: Seat[];
    seed: number;
    state: unknown;
    events: MatchEvent[];
    controllers?: Record<string, LlmSeatState>;
  }) => Promise<void>;
  clearLive?: (matchId: string) => Promise<void>;
  resume?: {
    state: unknown;
    events: MatchEvent[];
    /** Per-seat memories and counters saved with the live match. */
    controllers?: Record<string, unknown>;
  };
  matchId?: string;
}

export class MatchSession {
  readonly matchId: string;

  private readonly gate = new Gate();
  private abort = new AbortController();
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
  private running = false;
  private stopped: Promise<void> = Promise.resolve();
  private rewinding = false;
  private takenOver = new Set<SeatId>();
  private readonly seatVoices = new Map<SeatId, number>();
  /** The live LLM controller per seat (absent while the human covers a seat). */
  private readonly llmControllers = new Map<SeatId, LlmController>();
  /** Last known seat memory, kept across takeover and resume. */
  private readonly seatMemory = new Map<SeatId, LlmSeatState>();
  private phaseKey = '';
  private phaseStartedAt = Date.now();
  private phaseLimitMs: number | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.matchId = deps.matchId ?? `m-${randomUUID().slice(0, 8)}`;
    this.human = deps.seats.find((seat) => seat.kind === 'human') ?? null;
    this.speed = deps.request.speed ?? 1;
    this.gate.speed = this.speed;
    this.seed = deps.request.seed ?? Math.floor(Math.random() * 1e9);
    if (deps.resume) this.events = [...deps.resume.events];
    for (const [seatId, state] of Object.entries(deps.resume?.controllers ?? {})) {
      const seat = deps.seats.find((entry) => entry.id === seatId);
      if (seat?.kind === 'llm' && state && typeof state === 'object') {
        this.seatMemory.set(seatId, state as LlmSeatState);
      }
    }
    deps.request.seats.forEach((seat, index) => {
      if (typeof seat.voice === 'number' && deps.seats[index]) {
        this.seatVoices.set(deps.seats[index].id, seat.voice);
      }
    });
  }

  /** The chosen TTS speaker for a seat, or undefined for the automatic one. */
  voiceForSeat(seatId: SeatId): number | undefined {
    return this.seatVoices.get(seatId);
  }

  private clearPreviews(): void {
    for (const seat of this.deps.seats) {
      if (seat.kind === 'llm') this.deps.sendPreview(seat.id, '');
    }
  }

  async start(): Promise<void> {
    return this.run();
  }

  /**
   * Step back one action: stop the loop, drop the last event, rebuild the state
   * from the seed and log, then continue. The engine is deterministic, so the
   * rewound match is exactly the one that would have happened.
   */
  async rewind(steps = 1): Promise<void> {
    if (!this.running || this.events.length === 0) return;
    this.rewinding = true;
    this.clearPreviews();
    this.abort.abort();
    this.pendingReject?.(new Error('rewound'));
    this.pendingHuman = null;
    this.pendingReject = null;
    await this.stopped;

    this.events = this.events.slice(0, Math.max(0, this.events.length - steps));
    const state = this.replayAndCapture(this.events);
    this.persistLive(state);
    this.abort = new AbortController();
    this.status = 'running';
    this.paused = false;
    this.gate.setPaused(false);
    this.rewinding = false;
    void this.run({ state, events: this.events });
  }

  private async run(initial?: { state: unknown; events: MatchEvent[] }): Promise<void> {
    let resolveStopped: () => void = () => undefined;
    this.stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    this.running = true;
    try {
      if (this.controllers.size === 0) this.buildControllers();
      const resumed = initial ?? (this.deps.resume
        ? { state: this.deps.resume.state, events: this.deps.resume.events }
        : undefined);
      const state0 = resumed
        ? this.replayAndCapture(resumed.events)
        : this.setupAndCapture();
      this.push();

      const runtime = new Map<SeatId, Controller>();
      for (const [id, controller] of this.controllers) {
        runtime.set(id, new Abortable(controller, this.abort.signal));
      }

      const result = await runMatch(this.deps.def, this.deps.seats, runtime, {
        matchId: this.matchId,
        seed: this.seed,
        signal: this.abort.signal,
        actionTimeoutMs: 30 * 60 * 1000,
        maxInvalidActions: 3,
        maxActions: 4_000,
        options: this.gameOptions(),
        ...(resumed ? { initialState: state0, initialEvents: resumed.events } : {}),
        onEvent: (event, state) => this.onEvent(event, state),
      });
      this.events = result.events;
      await this.finish(result);
    } catch (error) {
      if (this.abort.signal.aborted) {
        if (!this.rewinding) {
          this.status = 'aborted';
          this.push();
          if (this.fatalError) this.deps.sendError(this.fatalError);
        }
      } else {
        this.status = 'aborted';
        this.deps.sendError(error instanceof Error ? error.message : String(error));
        this.push();
      }
    } finally {
      this.running = false;
      resolveStopped();
    }
  }

  private setupAndCapture(): unknown {
    const state = this.deps.def.setup({
      seed: this.seed,
      seats: this.deps.seats,
      options: this.gameOptions(),
    });
    this.capture(state);
    return state;
  }

  /** Rebuild every view for a given event log (used by resume and rewind). */
  private replayAndCapture(events: MatchEvent[]): unknown {
    let state = this.deps.def.setup({
      seed: this.seed,
      seats: this.deps.seats,
      options: this.gameOptions(),
    });
    this.snapshots = [];
    this.godSnapshots = [];
    this.capture(state, true);
    for (const event of events) {
      state = this.deps.def.apply(state, event.seatId, event.action);
      this.capture(state, true);
    }
    return state;
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

  takeover(seatId: SeatId): void {
    const seat = this.deps.seats.find((entry) => entry.id === seatId);
    if (!seat || seat.kind !== 'llm') return;
    // Keep the model's memory and spend so releasing the seat restores both.
    const current = this.llmControllers.get(seatId);
    if (current) {
      this.seatMemory.set(seatId, current.snapshot());
      this.llmControllers.delete(seatId);
    }
    this.controllers.set(seatId, new HumanController(this));
    this.takenOver.add(seatId);
    this.push();
  }

  release(seatId: SeatId): void {
    const seat = this.deps.seats.find((entry) => entry.id === seatId);
    if (!seat || !this.takenOver.has(seatId)) return;
    const client = this.deps.clientForSeat?.(seat) ?? this.deps.client;
    if (!client || !seat.modelId) return;
    const config: LlmSeatConfig = {
      model: seat.modelId,
      temperature: 0.85,
      ...(seat.persona ? { persona: seat.persona } : {}),
      ...(seat.budgetUsd ? { budgetUsd: seat.budgetUsd } : {}),
    };
    const controller = new LlmController({
      client,
      gameName: this.deps.def.name,
      config,
      onPreview: (text) => this.deps.sendPreview(seatId, text),
      isPreviewPublic: (view, type) => this.deps.def.previewIsPublic?.(view, type) ?? false,
    });
    const saved = this.seatMemory.get(seatId);
    if (saved) controller.restore(saved);
    this.llmControllers.set(seatId, controller);
    this.controllers.set(seatId, new PacedController(controller, this.gate));
    this.takenOver.delete(seatId);
    this.push();
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
    this.clearPreviews();
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
      const client = this.deps.clientForSeat?.(seat) ?? this.deps.client;
      if (!client) {
        throw new Error(`No model provider is configured for ${seat.name}`);
      }
      const config: LlmSeatConfig = {
        model: seat.modelId ?? '',
        temperature: 0.85,
        ...(seat.persona ? { persona: seat.persona } : {}),
        ...(seat.budgetUsd ? { budgetUsd: seat.budgetUsd } : {}),
      };
      const controller = new LlmController({
        client,
        gameName: this.deps.def.name,
        config,
        onPreview: (text) => this.deps.sendPreview(seat.id, text),
        isPreviewPublic: (view, type) => this.deps.def.previewIsPublic?.(view, type) ?? false,
      });
      const saved = this.seatMemory.get(seat.id);
      if (saved) controller.restore(saved);
      this.llmControllers.set(seat.id, controller);
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
      const health = this.healthOf(seat);
      // A seat that recovered from a transient hiccup should not keep a
      // permanent red banner on the table.
      if (health.status === 'error') {
        issues.push({
          seatId: seat.id,
          name: seat.name,
          message: health.message ?? 'model call failed',
          count: health.errors,
          ...(health.kind ? { kind: health.kind } : {}),
        });
      }
    }
    return issues;
  }

  private healthOf(seat: Seat): SeatHealth {
    const controller = this.llmControllers.get(seat.id);
    if (controller) {
      const health = controller.health();
      return {
        seatId: seat.id,
        name: seat.name,
        ...(seat.modelId ? { modelId: seat.modelId } : {}),
        status: health.status,
        calls: health.calls,
        errors: health.errors,
        retries: health.retries,
        costUsd: health.costUsd,
        avgLatencyMs: health.avgLatencyMs,
        ...(health.lastError ? { message: health.lastError } : {}),
        ...(health.lastErrorKind ? { kind: health.lastErrorKind } : {}),
      };
    }
    const saved = this.seatMemory.get(seat.id);
    if (!saved) {
      return {
        seatId: seat.id,
        name: seat.name,
        ...(seat.modelId ? { modelId: seat.modelId } : {}),
        status: 'idle',
        calls: 0,
        errors: 0,
        retries: 0,
        costUsd: 0,
        avgLatencyMs: 0,
      };
    }
    const recovered = saved.lastOkCall > saved.lastErrorCall;
    const status: SeatHealth['status'] =
      saved.errors > 0 && !recovered
        ? 'error'
        : (saved.retries ?? 0) > 0 || !saved.schemaSupported || !saved.temperatureSupported
          ? 'degraded'
          : 'ok';
    return {
      seatId: seat.id,
      name: seat.name,
      ...(seat.modelId ? { modelId: seat.modelId } : {}),
      status,
      calls: saved.calls,
      errors: saved.errors,
      retries: saved.retries ?? 0,
      costUsd: saved.costUsd,
      avgLatencyMs: saved.calls ? Math.round(saved.latencyMs / saved.calls) : 0,
      ...(saved.lastError ? { message: saved.lastError } : {}),
      ...(saved.lastErrorKind ? { kind: saved.lastErrorKind } : {}),
    };
  }

  private seatHealth(): SeatHealth[] {
    return this.deps.seats
      .filter((seat) => seat.kind === 'llm')
      .map((seat) => this.healthOf(seat));
  }

  private capture(state: unknown, silent = false): void {
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
    if (!silent) this.persistLive(state);
    this.snapshots.push(view);
    this.godSnapshots.push(god ?? view);
    this.refreshCost();
  }

  private persistLive(state: unknown): void {
    if (!this.deps.saveLive) return;
    void this.deps
      .saveLive({
        matchId: this.matchId,
        gameId: this.deps.def.id,
        gameName: this.deps.def.name,
        request: this.deps.request,
        seats: this.deps.seats,
        seed: this.seed,
        state,
        events: this.events,
        controllers: this.controllerSnapshots(),
      })
      .catch(() => undefined);
  }

  /**
   * Freeze every live seat's memory into the persisted map. A seat the human
   * is covering has no live controller, so its last snapshot is kept.
   */
  private controllerSnapshots(): Record<string, LlmSeatState> {
    for (const [seatId, controller] of this.llmControllers) {
      this.seatMemory.set(seatId, controller.snapshot());
    }
    return Object.fromEntries(this.seatMemory);
  }

  private refreshCost(): void {
    let total = 0;
    for (const seat of this.deps.seats) {
      const live = this.llmControllers.get(seat.id);
      total += live ? (live.usage?.().costUsd ?? 0) : (this.seatMemory.get(seat.id)?.costUsd ?? 0);
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
      // Keep omniscient snapshots on disk for replays, never in a live player's IPC payload.
      godView: this.human === null ? this.latest.god : null,
      humanSeatId: this.human?.id ?? null,
      awaitingHuman: this.pendingHuman !== null,
      seatIssues: this.seatIssues(),
      seatHealth: this.seatHealth(),
      takenOverSeats: [...this.takenOver],
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
    this.clearPreviews();
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
        formatVersion: 2,
        summary,
        options: this.gameOptions(),
        seats: this.deps.seats,
        seed: this.seed,
        events: result.events,
        views: this.snapshots,
        godViews: this.godSnapshots,
      });
    } catch (error) {
      console.error('[session] could not persist match', error);
    }

    void this.deps.clearLive?.(summary.matchId);
    void this.runDebrief(summary);
  }

  private async runDebrief(summary: MatchSummary): Promise<void> {
    if (!this.deps.client || !this.deps.debriefModel) return;
    try {
      const bundle: ReplayBundle = {
        summary,
        options: this.gameOptions(),
        seats: this.deps.seats,
        seed: this.seed,
        events: this.events,
        views: this.snapshots,
        godViews: this.godSnapshots,
      };
      const debrief = await generateDebrief({
        client: this.deps.client,
        model: this.deps.debriefModel,
        bundle,
      });
      if (!debrief) return;
      this.deps.sendDebrief({ matchId: summary.matchId, ...debrief });
      await this.deps.saveDebrief?.(summary.matchId, debrief);
    } catch (error) {
      console.error('[session] debrief failed', error);
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
      debriefExpected: Boolean(this.deps.debriefModel && this.deps.client),
    };
  }
}
