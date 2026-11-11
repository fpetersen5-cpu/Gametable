import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
import { ResultsStore, toRecord, type MatchRecord } from '@gametable/stats';
import { generateDebrief } from './debrief.js';
import { Budget, BudgetExceeded } from './budget.js';
import type {
  MatchSummary,
  ReplayBundle,
  SeatHealth,
  SeatIssue,
  StartMatchRequest,
  TableSnapshot,
} from '../shared/api.js';
import { REPLAY_FORMAT_VERSION } from '../shared/api.js';

/**
 * Paces AI seats and implements pause. The human seat is never gated: when it
 * is your turn, the table waits for you regardless of the speed setting.
 */
class Gate {
  paused = false;
  speed = 1;
  private waiting: Array<() => void> = [];

  async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    while (this.paused) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener('abort', abort);
          this.waiting = this.waiting.filter((entry) => entry !== resume);
        };
        const resume = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        this.waiting.push(resume);
        signal.addEventListener('abort', abort, { once: true });
      });
      signal.throwIfAborted();
    }
    if (this.speed >= 6) return;
    await delay(Math.round(700 / this.speed), undefined, { signal });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.waiting.splice(0).forEach((resolve) => resolve());
  }
}

/** Internal handoff: retry with the model without consuming an engine attempt. */
class SeatReleased extends Error {}

interface HumanRequest {
  req: ActionRequest;
  resolve: (action: GameAction) => void;
  reject: (error: Error) => void;
}

/**
 * Forwards cancellation and races it against the controller, so a rewind or
 * abort also stops promptly if a custom controller ignores the signal.
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

  async act(req: ActionRequest): Promise<GameAction> {
    const signal = req.signal && req.signal !== this.signal
      ? AbortSignal.any([req.signal, this.signal]) : this.signal;
    signal.throwIfAborted();
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.inner.act({ ...req, signal }), stopped]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
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
    spentUsd: number;
    state: unknown;
    events: MatchEvent[];
    controllers?: Record<string, LlmSeatState>;
  }) => Promise<void>;
  clearLive?: (matchId: string) => Promise<void>;
  resume?: {
    /** The actual setup seed, including when the original request omitted it. */
    seed: number;
    /** Includes charges settled before a cancelled action was applied. */
    spentUsd?: number;
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
  private readonly budget: Budget;
  private abort = new AbortController();
  private readonly controllers = new Map<SeatId, Controller>();
  private readonly human: Seat | null;
  private readonly seed: number;
  private readonly startedAt = Date.now();

  /** Simultaneous phases may ask the user to cover more than one seat. */
  private humanRequests: HumanRequest[] = [];
  private snapshots: GameView[] = [];
  private godSnapshots: GameView[] = [];
  private latest: { view: GameView; god: GameView | null } | null = null;
  private latestState: unknown;
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
  /** Retained while covered, including memory and spend from an in-flight call. */
  private readonly llmControllers = new Map<SeatId, LlmController>();
  /** Last known seat memory, kept across takeover and resume. */
  private readonly seatMemory = new Map<SeatId, LlmSeatState>();
  private phaseKey = '';
  private phaseStartedAt = Date.now();
  private phaseLimitMs: number | null = null;
  private liveWrites: Promise<void> = Promise.resolve();
  private liveSaveFailed = false;
  private completed: { record: MatchRecord; bundle: ReplayBundle } | null = null;
  private saving: Promise<{ ok: boolean; error?: string }> | null = null;
  private saveState: TableSnapshot['saveState'];
  private debriefStarted = false;

  constructor(private readonly deps: SessionDeps) {
    this.matchId = deps.matchId ?? `m-${randomUUID().slice(0, 8)}`;
    this.human = deps.seats.find((seat) => seat.kind === 'human') ?? null;
    this.speed = deps.request.speed ?? 1;
    this.gate.speed = this.speed;
    this.seed = deps.resume?.seed ?? deps.request.seed ?? Math.floor(Math.random() * 1e9);
    this.budget = new Budget(deps.request.budgetUsd, () => {
      if (this.status === 'finished') return;
      const amount = deps.request.budgetUsd.toFixed(deps.request.budgetUsd < 0.1 ? 4 : 2);
      this.fatalError = `Match budget of $${amount} reached.`;
      this.abortMatch();
    });
    this.budget.spend(deps.resume?.spentUsd ?? 0);
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
    if (!this.running || this.status !== 'running' || this.events.length === 0) return;
    this.rewinding = true;
    this.clearPreviews();
    this.abort.abort();
    this.rejectHumanRequests(new Error('rewound'));
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
      const state0 = resumed ? this.restoreState(resumed) : this.setupAndCapture();
      this.push();

      const runtime = new Map<SeatId, Controller>();
      const signal = this.abort.signal;
      for (const seat of this.deps.seats) {
        // Resolve the controller for each decision, rather than freezing it at start.
        runtime.set(seat.id, new Abortable({
          kind: seat.kind,
          act: (req) => this.actForSeat(req, signal),
          usage: () => this.llmControllers.get(seat.id)?.usage() ?? {},
        }, signal));
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
      await this.liveWrites;
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

  /**
   * Resume from the saved event log, but refuse to silently continue if the
   * rebuilt state differs from the snapshot written beside it.
   */
  private restoreState(resumed: { state: unknown; events: MatchEvent[] }): unknown {
    const replayed = this.replayAndCapture(resumed.events);
    if (
      resumed.state !== undefined &&
      JSON.stringify(replayed) !== JSON.stringify(resumed.state)
    ) {
      throw new Error('Saved recovery state does not match its event log.');
    }
    return replayed;
  }

  private async actForSeat(req: ActionRequest, signal: AbortSignal): Promise<GameAction> {
    while (!signal.aborted) {
      const controller = this.controllers.get(req.seat.id)!;
      if (controller.kind !== 'human') {
        await this.gate.wait(signal);
        if (signal.aborted) throw new Error('aborted');
        // A cover click during pause/pacing must take effect before calling the model.
        if (controller !== this.controllers.get(req.seat.id)) continue;
      }
      try {
        return await controller.act(req);
      } catch (error) {
        if (!(error instanceof SeatReleased)) throw error;
      }
    }
    throw new Error('aborted');
  }

  askHuman(req: ActionRequest): Promise<GameAction> {
    const current = this.deps.def.view(this.latestState, req.seat.id);
    if (
      this.abort.signal.aborted || current.legalActions.length === 0 ||
      current.phase.id !== req.view.phase.id || current.phase.round !== req.view.phase.round
    ) {
      return Promise.reject(new Error('turn ended'));
    }
    return new Promise<GameAction>((resolve, reject) => {
      this.humanRequests.push({ req, resolve, reject });
      this.push();
    });
  }

  submit(action: GameAction): void {
    const pending = this.humanRequests.shift();
    this.push();
    pending?.resolve(action);
  }

  private rejectHumanRequests(error: Error, seatId?: SeatId): void {
    const rejected = this.humanRequests.filter((entry) => !seatId || entry.req.seat.id === seatId);
    this.humanRequests = this.humanRequests.filter((entry) => !rejected.includes(entry));
    rejected.forEach((entry) => entry.reject(error));
  }

  /** Changes the next decision; an already-started model call finishes normally. */
  takeover(seatId: SeatId): void {
    if (!this.running || this.status !== 'running' || this.takenOver.has(seatId)) return;
    if (!this.llmControllers.has(seatId)) return;
    this.controllers.set(seatId, new HumanController(this));
    this.takenOver.add(seatId);
    this.push();
  }

  release(seatId: SeatId): void {
    if (!this.running || this.status !== 'running' || !this.takenOver.has(seatId)) return;
    const controller = this.llmControllers.get(seatId);
    if (!controller) return;
    this.controllers.set(seatId, controller);
    this.takenOver.delete(seatId);
    this.rejectHumanRequests(new SeatReleased('seat released'), seatId);
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
    if (this.status === 'finished') {
      this.abort.abort();
      return;
    }
    this.status = 'aborted';
    this.clearPreviews();
    this.abort.abort();
    this.rejectHumanRequests(new Error('aborted'));
    this.refreshCost();
    if (this.latest) this.persistLive(this.latestState);
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
        ...(seat.budgetUsd === undefined ? {} : { budgetUsd: seat.budgetUsd }),
      };
      const controller = new LlmController({
        client: this.budget.client(client),
        gameName: this.deps.def.name,
        config,
        onPreview: (text) => this.deps.sendPreview(seat.id, text),
        isPreviewPublic: (view, type) => this.deps.def.previewIsPublic?.(view, type) ?? false,
      });
      const saved = this.seatMemory.get(seat.id);
      if (saved) controller.restore(saved);
      this.llmControllers.set(seat.id, controller);
      this.controllers.set(seat.id, controller);
    }
    const restored = [...this.llmControllers.values()].reduce(
      (total, controller) => total + (controller.usage().costUsd ?? 0), 0,
    );
    this.budget.spend(Math.max(0, restored - this.budget.spentUsd));
  }

  private onEvent(event: MatchEvent, state: unknown): void {
    this.events.push(event);
    this.capture(state);
    this.push();

    if (this.budget.remaining() <= 0 && !this.deps.def.terminal(state)) {
      this.budget.exhausted();
      return;
    }

    // If every model seat is failing, a "match" would just be fallback moves.
    const issues = this.seatIssues();
    const modelSeats = this.deps.seats.filter(
      (seat) => seat.kind === 'llm' && !this.takenOver.has(seat.id),
    ).length;
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
      if (seat.kind !== 'llm' || this.takenOver.has(seat.id)) continue;
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
    this.latestState = state;
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
    // A deadline may move the phase on while human decisions are still queued.
    for (const { req } of this.humanRequests) {
      const current = this.deps.def.view(state, req.seat.id);
      if (current.legalActions.length === 0 || current.phase.id !== req.view.phase.id ||
          current.phase.round !== req.view.phase.round) {
        this.rejectHumanRequests(new Error('turn ended'), req.seat.id);
      }
    }

    this.latest = { view, god };
    if (!silent) this.persistLive(state);
    this.snapshots.push(view);
    this.godSnapshots.push(god ?? view);
    this.refreshCost();
  }

  private persistLive(state: unknown): void {
    if (!this.deps.saveLive) return;
    const snapshot = structuredClone({
      matchId: this.matchId,
      gameId: this.deps.def.id,
      gameName: this.deps.def.name,
      request: this.deps.request,
      seats: this.deps.seats,
      seed: this.seed,
      spentUsd: this.budget.spentUsd,
      state,
      events: this.events,
      controllers: this.controllerSnapshots(),
    });
    this.liveWrites = this.liveWrites.then(async () => {
      await this.deps.saveLive!(snapshot);
      this.liveSaveFailed = false;
    }).catch(() => {
      if (!this.liveSaveFailed) this.deps.sendError('Could not save recovery data. Check available disk space.');
      this.liveSaveFailed = true;
    });
  }

  /**
   * Freeze every model's memory into the persisted map, including covered seats.
   */
  private controllerSnapshots(): Record<string, LlmSeatState> {
    for (const [seatId, controller] of this.llmControllers) {
      this.seatMemory.set(seatId, controller.snapshot());
    }
    return Object.fromEntries(this.seatMemory);
  }

  private refreshCost(): void {
    this.costUsd = this.budget.spentUsd;
  }

  private push(): void {
    if (!this.latest) return;
    const pending = this.humanRequests[0];
    const spectator = this.human === null && !pending;
    this.deps.send({
      matchId: this.matchId,
      gameId: this.deps.def.id,
      gameName: this.deps.def.name,
      spectator,
      status: this.status,
      view: pending?.req.view ?? this.latest.view,
      // Keep omniscient snapshots on disk for replays, never in a live player's IPC payload.
      godView: spectator ? this.latest.god : null,
      humanSeatId: pending?.req.seat.id ?? this.human?.id ?? null,
      awaitingHuman: Boolean(pending),
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
      ...(this.saveState ? { saveState: this.saveState } : {}),
    });
  }

  private async finish(result: MatchResult): Promise<void> {
    this.clearPreviews();
    this.status = 'finished';
    this.saveState = { status: 'saving' };
    this.refreshCost();
    this.push();

    const summary = this.summarise(result);
    this.deps.sendFinished(summary);
    const personas = Object.fromEntries(this.deps.seats.filter((seat) => seat.persona)
      .map((seat) => [seat.id, seat.persona!]));
    this.completed = {
      record: toRecord(result, personas),
      bundle: {
        formatVersion: REPLAY_FORMAT_VERSION,
        summary,
        options: this.gameOptions(),
        seats: this.deps.seats,
        seed: this.seed,
        events: result.events,
        views: this.snapshots,
        godViews: this.godSnapshots,
      },
    };
    await this.retrySave();
  }

  retrySave(): Promise<{ ok: boolean; error?: string }> {
    if (!this.completed) return Promise.resolve({ ok: false, error: 'No finished match to save.' });
    if (this.saving) return this.saving;
    if (this.saveState?.status === 'saved') return Promise.resolve({ ok: true });
    this.saving = Promise.resolve().then(() => this.saveCompleted()).finally(() => { this.saving = null; });
    return this.saving;
  }

  private async saveCompleted(): Promise<{ ok: boolean; error?: string }> {
    const { record, bundle } = this.completed!;
    this.saveState = { status: 'saving' };
    this.push();
    try {
      // Never let an older autosave recreate or overwrite recovery data after cleanup.
      await this.liveWrites;
      await this.deps.store.appendOnce(record);
      await this.deps.saveBundle(bundle);
      await this.deps.clearLive?.(this.matchId);
    } catch {
      const error = 'Could not save the match. Recovery data has not been deleted. Free disk space or check permissions, then retry saving.';
      this.saveState = { status: 'error', error };
      this.push();
      return { ok: false, error };
    }
    this.saveState = { status: 'saved' };
    this.push();
    if (!this.debriefStarted) {
      this.debriefStarted = true;
      void this.runDebrief(bundle.summary);
    }
    return { ok: true };
  }

  private async runDebrief(summary: MatchSummary): Promise<void> {
    if (!this.deps.client || !this.deps.debriefModel || !summary.debriefExpected || this.abort.signal.aborted) return;
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
        client: {
          complete: (req) => this.budget.client(this.deps.client!).complete({
            ...req, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(90_000)]),
          }),
        },
        model: this.deps.debriefModel,
        bundle,
      });
      if (!debrief) {
        summary.debriefExpected = false;
        this.deps.sendFinished(summary);
        return;
      }
      this.deps.sendDebrief({ matchId: summary.matchId, ...debrief });
      await this.deps.saveDebrief?.(summary.matchId, debrief);
    } catch (error) {
      if (this.abort.signal.aborted) return;
      summary.debriefExpected = false;
      this.deps.sendFinished(summary);
      if (!(error instanceof BudgetExceeded)) this.deps.sendError('The after-match analysis could not be completed.');
    } finally {
      this.refreshCost();
      if (!this.abort.signal.aborted) this.push();
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
      debriefExpected: Boolean(this.deps.debriefModel && this.deps.client && this.budget.remaining() > 0),
    };
  }
}
