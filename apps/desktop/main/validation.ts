import { normalizeOpenAIBaseUrl } from '@gametable/agent';
import type {
  AppConfig,
  ArenaConfig,
  ProviderKind,
  SeatTestRequest,
  StartMatchRequest,
  TranscriptPerspective,
} from '../shared/api.js';
import { DEFAULT_CONFIG } from '../shared/api.js';

/** A rejected request. Handlers turn this into a user-facing error. */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export function validateTranscriptPerspective(raw: unknown): TranscriptPerspective {
  if (raw === undefined) return { mode: 'public' };
  const value = record(raw, 'transcript perspective');
  if (value.mode === 'public' || value.mode === 'omniscient') return { mode: value.mode };
  if (value.mode === 'seat') {
    return { mode: 'seat', seatId: asText(value.seatId, 'seat ID', 64) };
  }
  throw new BadRequest('Choose a public, seat, or omniscient transcript');
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequest(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function asText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string') throw new BadRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new BadRequest(`${field} cannot be empty`);
  if (trimmed.length > max) throw new BadRequest(`${field} is longer than ${max} characters`);
  return trimmed;
}

export function optionalText(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asText(value, field, max);
}

export function asNumber(value: unknown, field: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new BadRequest(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequest(`${field} must be a boolean`);
  return value;
}

function optionalVoice(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return Math.round(asNumber(value, 'voice', 0, 903));
}

function optionalProvider(value: unknown, field: string): ProviderKind | undefined {
  if (value === undefined || value === null || value === 'openrouter') return undefined;
  if (value === 'local') return 'local';
  throw new BadRequest(`${field} must be openrouter or local`);
}

function localEndpoint(value: unknown, field: string): string {
  const text = asText(value, field, 300);
  try {
    return normalizeOpenAIBaseUrl(text);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : `${field} is invalid`);
  }
}

function seatProvider(
  seat: Record<string, unknown>,
  field: string,
  fallbackEndpoint: string,
): { provider?: ProviderKind; baseUrl?: string } {
  const provider = optionalProvider(seat.provider, `${field} provider`);
  if (provider !== 'local') {
    return provider === undefined ? {} : { provider };
  }
  return {
    provider,
    baseUrl: localEndpoint(
      seat.baseUrl === undefined || seat.baseUrl === '' ? fallbackEndpoint : seat.baseUrl,
      `${field} base URL`,
    ),
  };
}

function asList(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new BadRequest(`${field} must contain ${min}–${max} items`);
  }
  return value;
}

export function validateStartRequest(raw: unknown): StartMatchRequest {
  const request = record(raw, 'match request');
  const seats = asList(request.seats, 'seats', 1, 11).map((entry, index) => {
    const seat = record(entry, `seat ${index + 1}`);
    const kind = seat.kind;
    if (kind !== 'human' && kind !== 'llm') {
      throw new BadRequest(`seat ${index + 1} must be human or llm`);
    }
    const seatKind: 'human' | 'llm' = kind;
    const modelId = optionalText(seat.modelId, `seat ${index + 1} modelId`, 200);
    if (kind === 'llm' && !modelId) {
      throw new BadRequest(`seat ${index + 1} is an AI seat without a model`);
    }
    const provider = seatProvider(seat, `seat ${index + 1}`, DEFAULT_CONFIG.localEndpoint);
    return {
      name: asText(seat.name, `seat ${index + 1} name`, 64),
      kind: seatKind,
      ...(modelId ? { modelId } : {}),
      ...provider,
      ...(optionalText(seat.persona, 'persona') ? { persona: optionalText(seat.persona, 'persona') } : {}),
      ...(optionalVoice(seat.voice) === undefined ? {} : { voice: optionalVoice(seat.voice) }),
      ...(seat.budgetUsd === undefined
        ? {}
        : { budgetUsd: asNumber(seat.budgetUsd, 'seat budget', 0, 1000) }),
    };
  });

  return {
    gameId: asText(request.gameId, 'gameId', 64),
    seats,
    budgetUsd: asNumber(request.budgetUsd, 'budgetUsd', 0, 1000),
    speed: asNumber(request.speed ?? 1, 'speed', 0.5, 8),
    ...(request.seed === undefined ? {} : { seed: asNumber(request.seed, 'seed', 0, 2 ** 31) }),
    trackOptimality: request.trackOptimality === true,
  };
}

export function validateConfig(raw: unknown): AppConfig {
  const config = record(raw, 'config');
  const endpoint = localEndpoint(
    config.localEndpoint ?? DEFAULT_CONFIG.localEndpoint,
    'localEndpoint',
  );
  const seats = asList(config.seats, 'seats', 0, 10).map((entry, index) => {
    const seat = record(entry, `seat ${index + 1}`);
    return {
      modelId: asText(seat.modelId, `seat ${index + 1} modelId`, 200),
      ...seatProvider(seat, `seat ${index + 1}`, endpoint),
      ...(optionalText(seat.persona, 'persona') ? { persona: optionalText(seat.persona, 'persona') } : {}),
      ...(optionalVoice(seat.voice) === undefined ? {} : { voice: optionalVoice(seat.voice) }),
      ...(seat.temperature === undefined
        ? {}
        : { temperature: asNumber(seat.temperature, 'temperature', 0, 2) }),
      ...(seat.budgetUsd === undefined
        ? {}
        : { budgetUsd: asNumber(seat.budgetUsd, 'seat budget', 0, 1000) }),
    };
  });

  return {
    humanName: asText(config.humanName ?? 'You', 'humanName', 64),
    seats,
    localEndpoint: endpoint,
    budgetUsd: asNumber(config.budgetUsd ?? 2, 'budgetUsd', 0, 1000),
    speed: asNumber(config.speed ?? 1, 'speed', 0.5, 8),
    voice: config.voice === undefined ? true : asBoolean(config.voice, 'voice'),
  };
}

export function validateLocalEndpoint(raw: unknown): string {
  return localEndpoint(raw, 'local endpoint');
}

export function validateSeatTests(raw: unknown): SeatTestRequest[] {
  return asList(raw, 'seats', 1, 10).map((entry, index) => {
    const seat = record(entry, `seat ${index + 1}`);
    return {
      name: asText(seat.name, `seat ${index + 1} name`, 64),
      modelId: asText(seat.modelId, `seat ${index + 1} modelId`, 200),
      ...seatProvider(seat, `seat ${index + 1}`, DEFAULT_CONFIG.localEndpoint),
    };
  });
}

export function validateArena(raw: unknown): ArenaConfig {
  const config = record(raw, 'arena config');
  const seats = asList(config.seats, 'seats', 1, 11).map((entry, index) => {
    const seat = record(entry, `seat ${index + 1}`);
    return {
      modelId: asText(seat.modelId, `seat ${index + 1} modelId`),
      name: asText(seat.name, `seat ${index + 1} name`, 64),
    };
  });
  return {
    gameId: asText(config.gameId, 'gameId', 64),
    seats,
    matches: Math.round(asNumber(config.matches, 'matches', 1, 200)),
    seedBase: Math.round(asNumber(config.seedBase ?? 0, 'seedBase', 0, 2 ** 31)),
    budgetPerMatch: asNumber(config.budgetPerMatch ?? 0.25, 'budgetPerMatch', 0, 1000),
    totalBudgetUsd: asNumber(config.totalBudgetUsd ?? 2, 'totalBudgetUsd', 0, 1000),
  };
}
