import { useEffect, useState } from 'react';
import type { LeaderboardRow } from '../../shared/api';
import { formatUsd } from '../game-data';

export function LeaderboardScreen() {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    void window.gametable.leaderboard().then(setRows);
  }, []);

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Leaderboard</h1>
          <p className="muted">
            Bradley–Terry ratings from matches played on this machine, adjusted for seat count and
            role. Buckshot also reports EV lost per decision against the solver.
          </p>
        </div>
        <button className="ghost" onClick={() => void window.gametable.leaderboard().then(setRows)}>
          Refresh
        </button>
      </header>

      {rows === null && <p className="muted">Loading…</p>}

      {rows?.length === 0 && (
        <div className="empty-state">
          <span className="big">★</span>
          <h2>No rated matches yet</h2>
          <p className="muted">
            Play a game with model seats. Ratings need models to beat each other — a human or bot
            win is recorded but does not move the board.
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
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
      )}
    </div>
  );
}
