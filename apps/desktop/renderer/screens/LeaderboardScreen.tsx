import { useCallback, useState } from 'react';
import type { GameInfo } from '../../shared/api';
import { formatUsd } from '../game-data';
import { useResource } from '../useResource';

export function LeaderboardScreen({ games }: { games: GameInfo[] }) {
  const [gameId, setGameId] = useState('');
  const { data: rows, loading, error, retry } = useResource(useCallback(
    () => window.gametable.leaderboard(gameId || undefined), [gameId],
  ), 'Leaderboard');

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <span className="eyebrow">LOCAL RANKINGS</span>
          <h1>The minds to beat.</h1>
          <p className="muted">
            Bradley–Terry ratings from your matches, normalized for table and team size. Lower
            Buckshot EV loss is better.
          </p>
        </div>
        <button className="ghost" disabled={loading} onClick={retry}>
          Refresh
        </button>
      </header>

      <label>Game
        <select value={gameId} onChange={(event) => setGameId(event.target.value)}>
          <option value="">All games</option>
          {games.map((game) => <option key={game.id} value={game.id}>{game.name}</option>)}
        </select>
      </label>
      {loading && <p className="muted">Loading…</p>}
      {error && <div className="banner error-banner" role="alert">{error}
        <button className="ghost" onClick={retry}>Retry</button>
      </div>}

      {rows?.length === 0 && (
        <div className="empty-state">
          <span className="big">★</span>
          <h2>No rated matches yet</h2>
          <p className="muted">
            Play a game with model seats{gameId ? ' in this game' : ''} to build your rankings.
            Results against humans and bots also count.
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="table-card">
          <table className="summary-table leaderboard">
            <thead>
              <tr>
                <th>#</th>
                <th>Model</th>
                <th>Rating</th>
                <th>Matches</th>
                <th>W / L</th>
                <th>Cost / match</th>
                <th>EV loss / decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.modelId}>
                  <td className="rank">{index + 1}</td>
                  <td>{row.modelId}</td>
                  <td className="rating">{row.rating.toFixed(0)}</td>
                  <td>{row.matches}</td>
                  <td>
                    {row.wins} / {row.losses}
                  </td>
                  <td>{formatUsd(row.avgCostUsd)}</td>
                  <td>
                    {row.metrics.evLossPerDecision !== undefined
                      ? row.metrics.evLossPerDecision.toFixed(4)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
