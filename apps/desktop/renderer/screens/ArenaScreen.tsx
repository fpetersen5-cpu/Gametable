import { useEffect, useMemo, useState } from 'react';
import type {
  AppConfig,
  ArenaProgress,
  GameInfo,
  ModelInfo,
} from '../../shared/api';
import { formatUsd, shortModel } from '../game-data';

interface Props {
  games: GameInfo[];
  config: AppConfig;
  models: ModelInfo[];
  onLeaderboard: () => void;
}

export function ArenaScreen({ games, config, models, onLeaderboard }: Props) {
  const [gameId, setGameId] = useState(games[0]?.id ?? '');
  const [matches, setMatches] = useState(10);
  const [seedBase, setSeedBase] = useState(() => Math.floor(Math.random() * 1_000_000));
  const [totalBudget, setTotalBudget] = useState(2);
  const [perMatchBudget, setPerMatchBudget] = useState(0.25);
  const [progress, setProgress] = useState<ArenaProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void window.gametable.arenaState().then(setProgress);
    return window.gametable.onArena((next) => setProgress(next));
  }, []);

  const game = games.find((entry) => entry.id === gameId) ?? games[0];
  const lineup = config.seats
    .filter((seat) => seat.modelId)
    .map((seat) => ({
      modelId: seat.modelId,
      name: models.find((model) => model.id === seat.modelId)?.name ?? shortModel(seat.modelId),
    }));

  const seatsPerMatch = game?.maxSeats === 2 ? 2 : lineup.length;
  const estimate = useMemo(() => {
    const perMatch = lineup
      .slice(0, seatsPerMatch)
      .reduce((sum, seat) => {
        const model = models.find((entry) => entry.id === seat.modelId);
        if (!model) return sum;
        return sum + 16 * (model.promptPrice * 1600 + model.completionPrice * 220);
      }, 0);
    return perMatch * matches;
  }, [lineup, models, seatsPerMatch, matches]);

  const running = progress?.running ?? false;
  const start = async () => {
    if (!game) return;
    setError(null);
    setStarting(true);
    try {
      const result = await window.gametable.arenaStart({
        gameId: game.id,
        seats: lineup,
        matches,
        seedBase,
        budgetPerMatch: perMatchBudget,
        totalBudgetUsd: totalBudget,
      });
      if (!result.ok) setError(result.error ?? 'Could not start the arena');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Arena</h1>
          <p className="muted">
            Unattended model-vs-model matches. Every match is saved as a replay and feeds the
            leaderboard.
          </p>
        </div>
        <button className="ghost" onClick={onLeaderboard}>
          Leaderboard
        </button>
      </header>

      {!running && (progress?.results.length ?? 0) === 0 && (
        <section className="arena-setup">
          <div className="game-picker">
            {games.map((entry) => (
              <button
                key={entry.id}
                className={`game-card${entry.id === gameId ? ' selected' : ''}`}
                onClick={() => setGameId(entry.id)}
              >
                <span className="game-glyph">{entry.capabilities.items ? '🔫' : '🎭'}</span>
                <div>
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.maxSeats === 2 ? 'duels, pairings rotate' : `${entry.minSeats}–${entry.maxSeats} seats`}
                  </small>
                </div>
              </button>
            ))}
          </div>

          <div className="arena-lineup">
            <h4>Lineup</h4>
            {lineup.length === 0 ? (
              <p className="muted">Add models on the Table screen first.</p>
            ) : (
              <div className="arena-chips">
                {lineup.map((seat) => (
                  <span key={seat.modelId} className="chip">
                    {seat.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="arena-fields">
            <label>
              Matches
              <input
                type="number"
                min={1}
                max={200}
                value={matches}
                onChange={(event) => setMatches(Number(event.target.value))}
              />
            </label>
            <label>
              Seed
              <input
                type="number"
                value={seedBase}
                onChange={(event) => setSeedBase(Number(event.target.value))}
              />
            </label>
            <label>
              Total budget $
              <input
                type="number"
                min={0}
                step={0.25}
                value={totalBudget}
                onChange={(event) => setTotalBudget(Number(event.target.value))}
              />
            </label>
            <label>
              Per match $
              <input
                type="number"
                min={0}
                step={0.05}
                value={perMatchBudget}
                onChange={(event) => setPerMatchBudget(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="callout">
            <div>
              <strong>{matches} matches · {seatsPerMatch} models each</strong>
              <p className="muted">
                Estimated ≈ {formatUsd(estimate)}. The run stops when it reaches{' '}
                {formatUsd(totalBudget)}.
              </p>
              {error && <p className="error">{error}</p>}
            </div>
            <button
              className="primary"
              onClick={() => void start()}
              disabled={starting || lineup.length === 0}
            >
              {starting ? 'Starting…' : 'Run the arena'}
            </button>
          </div>
        </section>
      )}

      {progress && (progress.total > 0 || progress.results.length > 0) && (
        <section className="arena-run">
          <div className="arena-status">
            <div>
              <strong>
                {progress.running
                  ? `Match ${Math.min(progress.index + 1, progress.total)} of ${progress.total}`
                  : `Run ${progress.error ? 'stopped' : 'complete'}`}
              </strong>
              <p className="muted">
                {progress.currentGame ?? progress.results.at(-1)?.gameName ?? ''}
                {progress.currentSeats ? ` · ${progress.currentSeats.join(' vs ')}` : ''}
                {progress.currentPhase ? ` · ${progress.currentPhase}` : ''}
              </p>
            </div>
            <div className="arena-controls">
              {progress.running && (
                <>
                  <button className="ghost" onClick={() => void window.gametable.arenaPause(!progress.paused)}>
                    {progress.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button className="ghost danger" onClick={() => void window.gametable.arenaCancel()}>
                    Stop
                  </button>
                </>
              )}
              <span className={progress.costUsd > progress.totalBudgetUsd * 0.85 ? 'cell-bad' : ''}>
                {formatUsd(progress.costUsd)}
              </span>
            </div>
          </div>

          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${Math.min(100, (progress.index / Math.max(1, progress.total)) * 100)}%` }}
            />
          </div>

          {progress.error && <p className="banner error-banner">{progress.error}</p>}

          {progress.results.length > 0 && (
            <table className="summary-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Match</th>
                  <th>Winner</th>
                  <th>Seats</th>
                  <th>Actions</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {progress.results.map((result, index) => (
                  <tr key={result.matchId}>
                    <td className="rank">{index + 1}</td>
                    <td>{result.gameName}</td>
                    <td>{result.winnerNames.join(' & ') || '—'}</td>
                    <td>
                      {result.seats.map((seat) => seat.modelId ?? seat.name).join(', ')}
                    </td>
                    <td>{result.eventCount}</td>
                    <td>{formatUsd(result.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!progress.running && progress.results.length > 0 && (
            <div className="postgame-actions">
              <button className="primary" onClick={() => setProgress(null)}>
                New run
              </button>
              <button className="ghost" onClick={onLeaderboard}>
                See the leaderboard
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
