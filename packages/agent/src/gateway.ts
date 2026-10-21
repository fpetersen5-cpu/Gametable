import {
  matchAction,
  type ActionRequest,
  type Controller,
  type GameAction,
  type Seat,
  type SeatId,
  type SeatUsage,
} from '@gametable/engine';
import {
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
}

export interface LlmControllerDeps {
  client: CompletionClient;
  gameName: string;
  config: LlmSeatConfig;
  /** Shared across every seat so the key is not hammered. */
  semaphore?: Semaphore;
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
    const call = (msgs: typeof messages) =>
      semaphore
        ? semaphore.run(() => this.callWithFallbacks(msgs, schema, req))
        : this.callWithFallbacks(msgs, schema, req);

    let result = await call(messages);
    let reply = parseJsonReply(result.text);
    let action = reply ? matchAction(legal, reply.action) : null;

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
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    schema: ReturnType<typeof actionSchema>,
    req: ActionRequest,
  ): Promise<CompletionResult> {
    const attempt = () =>
      this.complete(messages, this.schemaSupported ? schema : undefined, req);

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
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    schema: ReturnType<typeof actionSchema>,
    req: ActionRequest,
  ): Promise<CompletionResult> {
    const { client, config } = this.deps;
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
        signal: AbortSignal.timeout(Math.max(1_000, req.timeoutMs)),
      });
    } catch (error) {
      this.counters.errors += 1;
      this.lastError = describeError(error);
      this.lastErrorCall = this.counters.calls;
      throw error;
    }
    this.lastOkCall = this.counters.calls;
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
        if (message) return message.slice(0, 300);
        if (parsed.metadata?.raw) return parsed.metadata.raw.slice(0, 300);
      } catch {
        return body.slice(0, 300);
      }
    }
    return `HTTP ${status ?? '?'} from OpenRouter`;
  }
  if (error instanceof Error) {
    const cause = error.cause as { code?: string; message?: string } | undefined;
    const detail = cause?.code ?? cause?.message;
    const base = error.message || 'request failed';
    return (detail ? `${base} (${detail})` : base).slice(0, 300);
  }
  return String(error).slice(0, 300);
}
