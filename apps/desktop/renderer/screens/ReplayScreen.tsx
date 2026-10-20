import { useEffect, useState } from 'react';
import type { MatchSummary, ReplayBundle } from '../../shared/api';
import { formatUsd } from '../game-data';
import { GameTable } from '../components/GameTable';

export function ReplayScreen({ initialMatchId }: { initialMatchId?: string | null }) {
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [bundle, setBundle] = useState<ReplayBundle | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [reveal, setReveal] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void window.gametable.listMatches().then(setMatches);
  }, []);

  useEffect(() => {
    if (!initialMatchId) return;
    void window.gametable.loadReplay(initialMatchId).then((loaded) => {
      if (!loaded) return;
      setBundle(loaded);
      setIndex(0);
      setPlaying(false);
    });
  }, [initialMatchId]);

  useEffect(() => {
    if (!playing || !bundle) return;
    if (index >= bundle.views.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setIndex((current) => current + 1), 900 / speed);
    return () => clearTimeout(timer);
  }, [playing, index, bundle, speed]);

  const open = async (matchId: string) => {
    const loaded = await window.gametable.loadReplay(matchId);
    if (!loaded) {
      setNote('That replay could not be read.');
      return;
    }
    setBundle(loaded);
    setIndex(0);
    setPlaying(false);
    setNote(null);
  };

  const exportMatch = async (matchId: string) => {
    const result = await window.gametable.exportTranscript(matchId);
    setNote(result.ok ? `Saved to ${result.path}` : result.error ?? 'Export failed');
  };

  const views = bundle?.views ?? [];
  const display = bundle
    ? reveal
      ? bundle.godViews[index] ?? bundle.views[index]
      : bundle.views[index]
    : null;
  const activeEvent = bundle && index > 0 ? bundle.events[index - 1] : null;
  const canReveal = bundle?.summary.seats.some((seat) => seat.kind === 'human') ?? false;

  return (
    <div className="replay-screen">
      <aside className="replay-list">
        <h2>Replays</h2>
        {matches === null && <p className="muted">Loading…</p>}
        {matches?.length === 0 && (
          <p className="muted">Finished matches will appear here, with a scrubber for every action.</p>
        )}
        {matches?.map((match) => (
          <button
            key={match.matchId}
            className={`replay-item${bundle?.summary.matchId === match.matchId ? ' selected' : ''}`}
            onClick={() => void open(match.matchId)}
          >
            <strong>{match.gameName}</strong>
            <small>
              {new Date(match.startedAt).toLocaleString()} · {match.eventCount} actions
            </small>
            <small>
              {match.winnerNames.join(' & ') || 'no winner'} · {formatUsd(match.totalCostUsd)}
            </small>
          </button>
        ))}
      </aside>

      <main className="replay-viewer">
        {!bundle || !display ? (
          <div className="empty-state">
            <span className="big">◷</span>
            <h2>Pick a match</h2>
            <p className="muted">Step through every action, or let it play.</p>
          </div>
        ) : (
          <>
            <header className="replay-controls">
              <div>
                <h1>{bundle.summary.gameName}</h1>
                <p className="muted">
                  {bundle.summary.winnerNames.join(' & ') || 'no winner'} ·{' '}
                  {new Date(bundle.summary.startedAt).toLocaleString()}
                </p>
              </div>
              <div className="replay-buttons">
                <button className="ghost" onClick={() => setIndex(0)}>
                  ⏮
                </button>
                <button className="ghost" onClick={() => setIndex(Math.max(0, index - 1))}>
                  ◀
                </button>
                <button className="primary" onClick={() => setPlaying(!playing)}>
                  {playing ? 'Pause' : 'Play'}
                </button>
                <button
                  className="ghost"
                  onClick={() => setIndex(Math.min(views.length - 1, index + 1))}
                >
                  ▶
                </button>
                <label className="speed">
                  speed
                  <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                    {[0.5, 1, 2, 4, 8].map((value) => (
                      <option key={value} value={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                </label>
                {canReveal && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={reveal}
                      onChange={(event) => setReveal(event.target.checked)}
                    />
                    reveal all
                  </label>
                )}
                <button className="ghost" onClick={() => void exportMatch(bundle.summary.matchId)}>
                  Export
                </button>
              </div>
            </header>

            {note && <p className="export-note">{note}</p>}

            <div className="scrubber">
              <input
                type="range"
                min={0}
                max={Math.max(0, views.length - 1)}
                value={index}
                onChange={(event) => {
                  setPlaying(false);
                  setIndex(Number(event.target.value));
                }}
              />
              <span className="scrubber-label">
                {index} / {Math.max(0, views.length - 1)}
                {activeEvent && (
                  <>
                    {' · '}
                    {bundle.summary.seats.find((seat) => seat.seatId === activeEvent.seatId)?.name ??
                      activeEvent.seatId}{' '}
                    {activeEvent.action.type}
                    {typeof activeEvent.action.target === 'string' ? ` → ${activeEvent.action.target}` : ''}
                  </>
                )}
              </span>
            </div>

            <GameTable
              view={display}
              godView={reveal ? bundle.godViews[index] ?? null : null}
              humanSeatId={null}
              spectator={reveal}
              awaiting={false}
            />

            <div className="replay-meta">
              {bundle.summary.seats.map((seat) => (
                <span key={seat.seatId} className="chip">
                  {seat.name}: {formatUsd(seat.costUsd)}
                </span>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
