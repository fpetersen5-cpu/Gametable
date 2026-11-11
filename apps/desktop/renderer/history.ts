import type { MatchSummary } from '../shared/api';

export function filterMatches(matches: MatchSummary[], gameId: string, query: string): MatchSummary[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return matches.filter((match) => {
    if (gameId && match.gameId !== gameId) return false;
    const text = [match.matchId, match.gameName, ...match.winnerNames,
      ...match.seats.flatMap((seat) => [seat.name, seat.modelId ?? ''])].join(' ').toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
