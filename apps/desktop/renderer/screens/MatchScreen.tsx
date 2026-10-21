import { useEffect, useState } from 'react';
import type { GameAction, MatchSummary, TableSnapshot } from '../../shared/api';
import { formatUsd } from '../game-data';
import { GameTable } from '../components/GameTable';

interface Props {
  snapshot: TableSnapshot;
  summary: MatchSummary | null;
  error: string | null;
  exportNote: string | null;
  onAction: (action: GameAction) => void;
  onPause: (paused: boolean) => void;
  onSpeed: (speed: number) => void;
  onAbort: () => void;
  onExit: () => void;
  onReplay: () => void;
  onExport: () => void;
}

export function MatchScreen(props: Props) {
  const { snapshot, summary } = props;
  const [showSummary, setShowSummary] = useState(true);

  useEffect(() => {
    setShowSummary(true);
  }, [summary?.matchId]);

  const phase = snapshot.view.phase;
  const finished = snapshot.status === 'finished' || snapshot.status === 'aborted';
  const spent = Math.min(100, (snapshot.costUsd / Math.max(snapshot.budgetUsd, 0.01)) * 100);

  return (
    <div className="match-screen">
      <header className="match-head">
        <div className="match-title">
          <h1>{snapshot.gameName}</h1>
          <div className="phase-line">
            <span className="phase-chip">{phase.label}</span>
            {typeof phase.round === 'number' && <span className="chip">round {phase.round}</span>}
            {snapshot.spectator && <span className="chip spectator">spectating</span>}
            {snapshot.paused && <span className="chip warn">paused</span>}
          </div>
        </div>

        <div className="match-controls">
          <div className="cost-meter" title="Spend against your match budget">
            <span>{formatUsd(snapshot.costUsd)}</span>
            <small>/ {formatUsd(snapshot.budgetUsd)}</small>
            <div className="cost-track">
              <div
                className={`cost-fill${spent > 85 ? ' danger' : ''}`}
                style={{ width: `${spent}%` }}
              />
            </div>
          </div>

          {!finished && (
            <button className="ghost" onClick={() => props.onPause(!snapshot.paused)}>
              {snapshot.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <label className="speed">
            speed
            <select
              value={snapshot.speed}
              onChange={(event) => props.onSpeed(Number(event.target.value))}
            >
              {[0.5, 1, 2, 4, 8].map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
          {!finished && (
            <button className="ghost danger" onClick={props.onAbort}>
              Abort
            </button>
          )}
          <button className="ghost" onClick={props.onExit}>
            Leave
          </button>
        </div>
      </header>

      {props.error && <div className="banner error-banner">{props.error}</div>}
      {snapshot.seatIssues.length > 0 && (
        <div className="banner error-banner">
          <strong>Model calls are failing — moves are being skipped.</strong>
          <ul className="issue-list">
            {snapshot.seatIssues.map((issue) => (
              <li key={issue.seatId}>
                <span>{issue.name}</span>: {issue.message}{' '}
                <span className="muted">({issue.count}×)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {snapshot.status === 'aborted' && (
        <div className="banner warn-banner">Match aborted.</div>
      )}

      <GameTable
        view={snapshot.view}
        godView={snapshot.godView}
        humanSeatId={snapshot.humanSeatId}
        spectator={snapshot.spectator}
        awaiting={snapshot.awaitingHuman}
        onAction={props.onAction}
      />

      {summary && showSummary && (
        <div className="postgame-overlay" onClick={() => setShowSummary(false)}>
          <div className="postgame" onClick={(event) => event.stopPropagation()}>
            <PostGame
              summary={summary}
              exportNote={props.exportNote}
              onExit={props.onExit}
              onReplay={props.onReplay}
              onExport={props.onExport}
              onClose={() => setShowSummary(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PostGame(props: {
  summary: MatchSummary;
  exportNote: string | null;
  onExit: () => void;
  onReplay: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const { summary } = props;
  return (
    <section className="postgame">
      <header className="postgame-head">
        <div>
          <span className="eyebrow">Match over</span>
          <h2>
            {summary.winnerNames.length > 0
              ? `${summary.winnerNames.join(' & ')} won`
              : 'No winner'}
          </h2>
          <p className="muted">
            {summary.eventCount} actions · {(summary.durationMs / 1000).toFixed(1)}s ·{' '}
            {formatUsd(summary.totalCostUsd)}
          </p>
        </div>
        <div className="postgame-actions">
          <button className="primary" onClick={props.onExit}>
            New match
          </button>
          <button className="ghost" onClick={props.onReplay}>
            Watch replay
          </button>
          <button className="ghost" onClick={props.onExport}>
            Export transcript
          </button>
          <button className="ghost" onClick={props.onClose}>
            Back to table
          </button>
        </div>
      </header>

      {props.exportNote && <p className="export-note">{props.exportNote}</p>}

      <table className="summary-table">
        <thead>
          <tr>
            <th>Seat</th>
            <th>Kind</th>
            <th>Role</th>
            <th>Cost</th>
            <th>Tokens</th>
            <th>EV loss / decision</th>
            <th>Invalid</th>
            <th>Failed calls</th>
          </tr>
        </thead>
        <tbody>
          {summary.seats.map((seat) => (
            <tr key={seat.seatId} className={summary.winners.includes(seat.seatId) ? 'won' : ''}>
              <td>{seat.name}</td>
              <td>{seat.modelId ?? seat.kind}</td>
              <td>{seat.role ?? '—'}</td>
              <td>{formatUsd(seat.costUsd)}</td>
              <td>
                {seat.tokensIn}/{seat.tokensOut}
              </td>
              <td>
                {seat.metrics?.evLossPerDecision !== undefined
                  ? seat.metrics.evLossPerDecision.toFixed(4)
                  : '—'}
              </td>
              <td>{seat.invalidActions}</td>
              <td className={seat.errors ? 'cell-bad' : ''}>{seat.errors ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {Object.keys(summary.metrics).length > 0 && (
        <div className="metric-chips">
          {Object.entries(summary.metrics).map(([key, value]) => (
            <span key={key} className="chip">
              {key}: {value}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
