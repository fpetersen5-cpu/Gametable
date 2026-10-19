import type { MatchResult } from '@gametable/engine';

/** The frozen results record. Additions must be optional (semver). */
export interface MatchRecord {
  matchId: string;
  gameId: string;
  gameVersion: string;
  engineVersion: string;
  seed: number;
  startedAt: number;
  durationMs: number;
  seats: Array<{
    seatId: string;
    name: string;
    kind: 'human' | 'llm' | 'bot';
    modelId?: string;
    persona?: string;
    role?: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    invalidActions: number;
    fallbacks: number;
  }>;
  winnerSeats: string[];
  scores: Record<string, number>;
  metrics: Record<string, number>;
}

export function toRecord(result: MatchResult, personas: Record<string, string> = {}): MatchRecord {
  return {
    matchId: result.matchId,
    gameId: result.gameId,
    gameVersion: result.gameVersion,
    engineVersion: result.engineVersion,
    seed: result.seed,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    seats: result.seats.map((seat) => ({
      seatId: seat.seatId,
      name: seat.name,
      kind: seat.kind,
      modelId: seat.modelId,
      persona: personas[seat.seatId],
      role: seat.role,
      tokensIn: seat.usage.tokensIn,
      tokensOut: seat.usage.tokensOut,
      costUsd: seat.usage.costUsd,
      latencyMs: seat.usage.latencyMs,
      invalidActions: seat.usage.invalidActions,
      fallbacks: seat.usage.fallbacks,
    })),
    winnerSeats: result.winners,
    scores: result.scores,
    metrics: result.metrics,
  };
}
