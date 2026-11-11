import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptPerspective } from '../../shared/api';
import { formatUsd } from '../game-data';
import { GameTable } from '../components/GameTable';
import { useResource } from '../useResource';
import { errorMessage } from '../async';
import { filterMatches } from '../history';

export function ReplayScreen({
  initialMatchId,
  scene3dEnabled = true,
}: {
  initialMatchId?: string | null;
  scene3dEnabled?: boolean;
}) {
  const history = useResource(useCallback(() => window.gametable.listMatches(), []), 'Replay history');
  const matches = history.data;
  const [selectedId, setSelectedId] = useState(initialMatchId ?? null);
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const [query, setQuery] = useState('');
  const [gameId, setGameId] = useState('');
  const replay = useResource(useCallback(async () => {
    if (!selectedId) return null;
    const loaded = await window.gametable.loadReplay(selectedId);
    if (!loaded || loaded.views.length === 0) throw new Error('That replay could not be read or has no saved views.');
    return loaded;
  }, [selectedId]), 'Replay');
  const bundle = replay.data;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [viewAs, setViewAs] = useState<'god' | 'you' | string>('god');
  const [note, setNote] = useState<string | null>(null);
  const isSeat = viewAs !== 'god' && viewAs !== 'you';
  const perspective = useResource(useCallback(async () => {
    if (!bundle || !isSeat) return null;
    const result = await window.gametable.replaySeatViews(bundle.summary.matchId, viewAs);
    if (!result.views) throw new Error(result.error ?? 'That seat view could not be rebuilt.');
    return result.views;
  }, [bundle, isSeat, viewAs]), 'Seat perspective');

  useEffect(() => {
    if (!initialMatchId) return;
    setSelectedId(initialMatchId);
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

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
    setNote(null);
    setViewAs('god');
  }, [selectedId]);

  useEffect(() => {
    if (!bundle) return;
    setViewAs(
      bundle.summary.seats.some((seat) => seat.kind === 'human') ? 'you' : 'god',
    );
  }, [bundle?.summary.matchId]);

  const exportMatch = async (matchId: string, perspective: TranscriptPerspective) => {
    try {
      const result = await window.gametable.exportTranscript(matchId, perspective);
      if (selection.current === matchId) setNote(result.ok ? `Saved to ${result.path}` : result.error ?? 'Export failed');
    } catch (error) {
      if (selection.current === matchId) setNote(errorMessage(error));
    }
  };

  const views = bundle?.views ?? [];
  const hasHuman = bundle?.summary.seats.some((seat) => seat.kind === 'human') ?? false;
  const display = bundle
    ? viewAs === 'god'
      ? bundle.godViews[index] ?? bundle.views[index]
      : viewAs === 'you'
        ? bundle.views[index]
        : perspective.data?.[index] ?? null
    : null;
  // Raw events may contain private targets or card choices. They are only an
  // omniscient replay feature, not part of any seat's perspective.
  const activeEvent = viewAs === 'god' && bundle && index > 0 ? bundle.events[index - 1] : null;
  const shownSeat = bundle?.summary.seats.find((seat) => seat.seatId === viewAs);
  const exportSeat = viewAs === 'you'
    ? bundle?.seats.find((seat) => seat.kind === 'human')?.id
    : isSeat ? viewAs : undefined;
  const filtered = filterMatches(matches ?? [], gameId, query);
  const gameOptions = [...new Map((matches ?? []).map((match) => [match.gameId, match.gameName]))];

  return (
    <div className="replay-screen">
      <aside className="replay-list">
        <h2>Replays</h2>
        <div className="history-filters">
          <label>Search
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Player, model, winner or match ID" />
          </label>
          <label>Game
            <select value={gameId} onChange={(event) => setGameId(event.target.value)}>
              <option value="">All games</option>
              {gameOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <button className="ghost" disabled={history.loading} onClick={history.retry}>Refresh</button>
        </div>
        {history.loading && <p className="muted">Loading…</p>}
        {history.error && <div className="banner error-banner" role="alert">{history.error}
          <button className="ghost" onClick={history.retry}>Retry</button>
        </div>}
        {matches?.length === 0 && (
          <p className="muted">Finished matches will appear here, with a scrubber for every action.</p>
        )}
        {matches && matches.length > 0 && <p className="muted">{filtered.length} of {matches.length} matches</p>}
        {matches && matches.length > 0 && filtered.length === 0 && <p className="muted">No matches found. Try another search or game.</p>}
        {filtered.map((match) => (
          <button
            key={match.matchId}
            className={`replay-item${selectedId === match.matchId ? ' selected' : ''}`}
            onClick={() => setSelectedId(match.matchId)}
          >
            <strong>{match.gameName}</strong>
            <small>
              {new Date(match.startedAt).toLocaleString()} · {match.eventCount} actions
            </small>
            <small>{match.seats.map((seat) => seat.name).join(' · ')}</small>
            <small>{match.matchId}</small>
            <small>
              {match.winnerNames.join(' & ') || 'no winner'} · {formatUsd(match.totalCostUsd)}
            </small>
          </button>
        ))}
      </aside>

      <main className="replay-viewer">
        {note && <p className="export-note" role="status">{note}</p>}
        {selectedId && replay.loading && <p className="muted">Loading replay…</p>}
        {replay.error && <div className="banner error-banner" role="alert">{replay.error}
          <button className="ghost" onClick={replay.retry}>Retry</button>
        </div>}
        {!selectedId ? (
          <div className="empty-state">
            <span className="big">◷</span>
            <h2>Pick a match</h2>
            <p className="muted">Step through every action, or let it play.</p>
          </div>
        ) : bundle ? (
          <>
            <header className="replay-controls">
              <div>
                <span className="eyebrow">MATCH REPLAY</span>
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
                <label className="check">
                  view as
                  <select
                    value={viewAs}
                    onChange={(event) => setViewAs(event.target.value)}
                  >
                    <option value="god">God (all roles)</option>
                    {hasHuman && <option value="you">You</option>}
                    {bundle.seats.map((seat) => (
                      <option key={seat.id} value={seat.id}>
                        {seat.name}
                      </option>
                    ))}
                  </select>
                </label>
                {isSeat && perspective.loading && <span className="muted">Loading perspective…</span>}
                <button className="ghost" onClick={() => void exportMatch(bundle.summary.matchId, { mode: 'public' })}>
                  Export public
                </button>
                {exportSeat && (
                  <button className="ghost" onClick={() => void exportMatch(bundle.summary.matchId, { mode: 'seat', seatId: exportSeat })}>
                    Export this seat…
                  </button>
                )}
                {viewAs === 'god' && (
                  <button className="ghost" onClick={() => void exportMatch(bundle.summary.matchId, { mode: 'omniscient' })}>
                    Export omniscient…
                  </button>
                )}
              </div>
            </header>

            {isSeat && perspective.error && <div className="banner error-banner" role="alert">{perspective.error}
              <button className="ghost" onClick={perspective.retry}>Retry perspective</button>
            </div>}

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

            {isSeat && (
              <p className="muted replay-perspective">
                Seeing only what <strong>{shownSeat?.name}</strong> saw.
              </p>
            )}

            {display && <GameTable
              view={display}
              godView={viewAs === 'god' ? bundle.godViews[index] ?? null : null}
              humanSeatId={
                viewAs === 'you'
                  ? bundle.summary.seats.find((seat) => seat.kind === 'human')?.seatId ?? null
                  : null
              }
              spectator={viewAs === 'god'}
              awaiting={false}
              scene3dEnabled={scene3dEnabled}
            />}

            <div className="replay-meta">
              {bundle.summary.seats.map((seat) => (
                <span key={seat.seatId} className="chip">
                  {seat.name}: {formatUsd(seat.costUsd)}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
