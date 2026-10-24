import {
  matchAction,
  type ActionRequest,
  type Controller,
  type GameAction,
  type GameView,
  type Seat,
  type SeatId,
  type SeatUsage,
} from '@gametable/engine';
import {
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ProviderPreferences,
} from './openrouter.js';
import {
  actionSchema,
  buildSystemPrompt,
  buildUserPrompt,
  parseJsonReply,
} from './prompt.js';
import { Semaphore } from './semaphore.js';
import { redact } from './redact.js';
import { actionTextPreview, actionTypePreview } from './preview.js';

export interface LlmSeatConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  persona?: string;
  provider?: ProviderPreferences;
  /** Hard cap for this seat; once reached it stops acting. */
  budgetUsd?: number;
  /** How much recent table talk to include verbatim. */
  maxChatLines?: number;
  /** Hard cap for one model call, regardless of the seat's turn budget. */
  timeoutMs?: number;
}

/**
 * A spend cap shared by every seat in a match. Each call checks the remaining
 * amount first and records its cost afterwards, so a group of seats cannot
 * collectively blow through a table-level budget.
 */
export interface SharedBudget {
  /** USD left before the shared cap. */
  remaining(): number;
  /** Record spend after a successful call. */
  spend(costUsd: number): void;
  /** Called once when a call is refused because the cap has been reached. */
  exhausted(): void;
}

/** Everything an LLM seat keeps between turns, for resume and takeover. */
export interface LlmSeatState {
  notes: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  invalidActions: number;
  fallbacks: number;
  errors: number;
  schemaSupported: boolean;
  temperatureSupported: boolean;
  lastOkCall: number;
  lastErrorCall: number;
  lastError: string | null;
}

export interface LlmControllerDeps {
  client: CompletionClient;
  gameName: string;
  config: LlmSeatConfig;
  sharedBudget?: SharedBudget;
  /** Shared across every seat so the key is not hammered. */
  semaphore?: Semaphore;
  /**
   * Live preview of a public speech as it is generated. Only called for
   * actions that are public in every legal variant, so a private whisper can
   * never flash on the table. An empty string clears the preview.
   */
  onPreview?: (text: string) => void;
  /**
   * Game rule: does this action type produce public table talk? Live previews
   * are suppressed for private channels (for example mafia night talk).
   */
  isPreviewPublic?: (view: GameView, actionType: string) => boolean;
}

export interface CompletionClient {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * An LLM seat. It sees exactly the projection the human seat sees, and can only
 * emit an action the engine already offered.
 */
export class LlmController implements Controller {
  readonly kind = 'llm' as const;
  private notes = '';
  private counters = {
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    latencyMs: 0,
    invalidActions: 0,
    fallbacks: 0,
    errors: 0,
  };
  private lastError: string | null = null;
  /** Some models do not accept response_format / temperature at all. */
  private schemaSupported = true;
  private temperatureSupported = true;
  private lastOkCall = -1;
  private lastErrorCall = -1;

  constructor(private readonly deps: LlmControllerDeps) {}

  async act(req: ActionRequest): Promise<GameAction> {
    const { client, gameName, config, semaphore } = this.deps;
    const legal = req.view.legalActions;
    if (legal.length === 0) throw new Error(`no legal actions for ${req.seat.id}`);

    const seatNames = new Map(req.view.seats.map((s) => [s.id, s.name]));
    const system = buildSystemPrompt({
      gameName,
      briefing: req.view.briefing,
      seat: req.seat,
      persona: config.persona,
      legalActions: legal,
    });
    const messages = [
      { role: 'system' as const, content: system },
      ...buildUserPrompt({
        view: req.view,
        seatNames,
        memoryNotes: this.notes,
        maxChatLines: config.maxChatLines ?? 18,
      }),
    ];

    const schema = actionSchema(legal);
    // A preview is only safe when every spoken variant is public; whispers
    // carry a `to` field and must never reach another seat's screen early.
    const spoken = legal.filter((entry) => typeof entry.text === 'string');
    const canPreview =
      Boolean(this.deps.onPreview) &&
      Boolean(this.deps.isPreviewPublic) &&
      spoken.length > 0;
    let previewShown = false;
    const clearPreview = () => {
      if (!previewShown) return;
      previewShown = false;
      this.deps.onPreview?.('');
    };
    const onText = canPreview
      ? (text: string) => {
          const type = actionTypePreview(text);
          const isPublic = type !== null && this.deps.isPreviewPublic?.(req.view, type) === true;
          if (!isPublic) {
            clearPreview();
            return;
          }
          const value = actionTextPreview(text);
          if (!value) return;
          previewShown = true;
          this.deps.onPreview?.(value);
        }
      : undefined;
    const call = (msgs: typeof messages) =>
      semaphore
        ? semaphore.run(() => this.callWithFallbacks(msgs, schema, req, onText))
        : this.callWithFallbacks(msgs, schema, req, onText);

    let result: CompletionResult;
    let reply: ReturnType<typeof parseJsonReply>;
    let action: GameAction | null;
    try {
      result = await call(messages);
      reply = parseJsonReply(result.text);
      action = reply ? matchAction(legal, reply.action) : null;

      if (!action) {
        this.counters.invalidActions += 1;
        messages.push(
          { role: 'assistant', content: result.text.slice(0, 2_000) },
          {
            role: 'user',
            content:
              'That reply was not one of the legal actions. Respond again with a single JSON ' +
              'object whose "action" copies one legal action exactly, including its "type".',
          },
        );
        result = await call(messages);
        reply = parseJsonReply(result.text);
        action = reply ? matchAction(legal, reply.action) : null;
      }
    } finally {
      clearPreview();
    }

    if (!action) {
      throw new Error(
        `model ${config.model} did not produce a legal action for seat ${req.seat.id}`,
      );
    }

    if (typeof reply?.notes === 'string' && reply.notes.trim()) {
      this.notes = reply.notes.trim().slice(-1_200);
    }
    return action;
  }

  usage(): Partial<SeatUsage> {
    return {
      calls: this.counters.calls,
      tokensIn: this.counters.tokensIn,
      tokensOut: this.counters.tokensOut,
      costUsd: Number(this.counters.costUsd.toFixed(6)),
      latencyMs: this.counters.latencyMs,
      invalidActions: this.counters.invalidActions,
      errors: this.counters.errors,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      recovered: this.lastOkCall > this.lastErrorCall,
    };
  }

  /** The seat's memory and counters, for persisting a resumable match. */
  snapshot(): LlmSeatState {
    return {
      notes: this.notes,
      ...this.counters,
      schemaSupported: this.schemaSupported,
      temperatureSupported: this.temperatureSupported,
      lastOkCall: this.lastOkCall,
      lastErrorCall: this.lastErrorCall,
      lastError: this.lastError,
    };
  }

  /**
   * Restore a snapshot taken before the app closed or the seat was taken over.
   * The data comes from our own live file, but it is validated anyway: a
   * corrupt value must never poison a running match.
   */
  restore(state: unknown): void {
    if (typeof state !== 'object' || state === null) return;
    const saved = state as Partial<LlmSeatState>;
    const number = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    this.notes = typeof saved.notes === 'string' ? saved.notes.slice(-1_200) : '';
    this.counters = {
      calls: number(saved.calls),
      tokensIn: number(saved.tokensIn),
      tokensOut: number(saved.tokensOut),
      costUsd: number(saved.costUsd),
      latencyMs: number(saved.latencyMs),
      invalidActions: number(saved.invalidActions),
      fallbacks: number(saved.fallbacks),
      errors: number(saved.errors),
    };
    this.schemaSupported = saved.schemaSupported !== false;
    this.temperatureSupported = saved.temperatureSupported !== false;
    this.lastOkCall = number(saved.lastOkCall);
    this.lastErrorCall = number(saved.lastErrorCall);
    this.lastError = typeof saved.lastError === 'string' ? saved.lastError.slice(0, 300) : null;
  }

  /** The most recent transport/API failure, for the table banner. */
  get errorMessage(): string | null {
    return this.lastError;
  }

  get privateNotes(): string {
    return this.notes;
  }

  /**
   * Models differ in which request parameters they accept, and
   * `require_parameters` turns that into a hard routing failure ("No endpoints
   * found"). We therefore never require parameters, and if a provider still
   * rejects the schema or the temperature, we retry once without it for the
   * rest of the match.
   */
  private async callWithFallbacks(
    messages: ChatMessage[],
    schema: ReturnType<typeof actionSchema>,
    req: ActionRequest,
    onText?: (text: string) => void,
  ): Promise<CompletionResult> {
    const attempt = () =>
      this.complete(messages, this.schemaSupported ? schema : undefined, req, onText);

    try {
      return await attempt();
    } catch (error) {
      const message = describeError(error).toLowerCase();
      let degraded = false;
      if (this.schemaSupported && /response_format|json_schema|structured|invalid schema|schema/.test(message)) {
        this.schemaSupported = false;
        degraded = true;
      }
      if (this.temperatureSupported && /temperature|no endpoints found/.test(message)) {
        this.temperatureSupported = false;
        degraded = true;
      }
      if (!degraded) throw error;
      // The failed probe was a capability mismatch, not a seat failure.
      this.counters.errors = Math.max(0, this.counters.errors - 1);
      this.lastError = null;
      return attempt();
    }
  }

  private async complete(
    messages: ChatMessage[],
    schema: ReturnType<typeof actionSchema>,
    req: ActionRequest,
    onText?: (text: string) => void,
  ): Promise<CompletionResult> {
    const { client, config } = this.deps;
    const shared = this.deps.sharedBudget;
    if (shared && shared.remaining() <= 0) {
      shared.exhausted();
      throw new Error('Arena budget reached.');
    }
    if (config.budgetUsd !== undefined && this.counters.costUsd >= config.budgetUsd) {
      throw new Error(
        `Seat budget of $${config.budgetUsd.toFixed(2)} reached (spent $${this.counters.costUsd.toFixed(3)}).`,
      );
    }
    this.counters.calls += 1;
    const temperature = this.temperatureSupported ? (config.temperature ?? 0.8) : undefined;
    let result: CompletionResult;
    try {
      result = await client.complete({
        model: config.model,
        messages,
        ...(temperature === undefined ? {} : { temperature }),
        maxTokens: config.maxTokens ?? 600,
        ...(schema ? { jsonSchema: schema } : {}),
        provider: {
          allowFallbacks: true,
          ...config.provider,
        },
        signal: AbortSignal.timeout(
          Math.max(1_000, Math.min(req.timeoutMs, config.timeoutMs ?? 90_000)),
        ),
        ...(onText ? { onText } : {}),
      });
    } catch (error) {
      this.counters.errors += 1;
      this.lastError = describeError(error);
      this.lastErrorCall = this.counters.calls;
      throw error;
    }
    this.lastOkCall = this.counters.calls;
    this.deps.sharedBudget?.spend(result.usage.costUsd);
    this.counters.tokensIn += result.usage.promptTokens;
    this.counters.tokensOut += result.usage.completionTokens;
    this.counters.costUsd += result.usage.costUsd;
    this.counters.latencyMs += result.latencyMs;
    return result;
  }
}

/** Build controllers for an all-LLM table (spectator mode or Gauntlet). */
export function createLlmControllers(
  seats: Seat[],
  configs: Map<SeatId, LlmSeatConfig>,
  client: CompletionClient,
  gameName: string,
  concurrency = 6,
): Map<SeatId, LlmController> {
  const semaphore = new Semaphore(concurrency);
  const controllers = new Map<SeatId, LlmController>();
  for (const seat of seats) {
    const config = configs.get(seat.id);
    if (!config) throw new Error(`no LLM config for seat ${seat.id}`);
    controllers.set(seat.id, new LlmController({ client, gameName, config, semaphore }));
  }
  return controllers;
}

/** Turn a failure into one human sentence, including the underlying cause. */
export function describeError(error: unknown): string {
  if (error instanceof Error && 'status' in error) {
    const status = (error as { status?: number }).status;
    const body = (error as { body?: string }).body;
    if (body) {
      try {
        const parsed = JSON.parse(body) as {
          error?: { message?: string } | string;
          metadata?: { raw?: string };
        };
        const message =
          typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
        if (message) return redact(message).slice(0, 300);
        if (parsed.metadata?.raw) return redact(parsed.metadata.raw).slice(0, 300);
      } catch {
        return redact(body).slice(0, 300);
      }
    }
    return `HTTP ${status ?? '?'} from OpenRouter`;
  }
  if (error instanceof Error) {
    const cause = error.cause as { code?: string; message?: string } | undefined;
    const detail = cause?.code ?? cause?.message;
    const base = error.message || 'request failed';
    return redact(detail ? `${base} (${detail})` : base).slice(0, 300);
  }
  return redact(String(error)).slice(0, 300);
}
