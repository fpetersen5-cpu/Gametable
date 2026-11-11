import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatLine, Phase, SeatInfo } from '../../shared/api';
import { seatColor, shortModel } from '../game-data';
import { MafiaDiorama } from './mafia-diorama';
import { mafiaPhaseIsNight, mafiaNightMessage, mafiaSceneState } from './mafia-scene-state';
import type { CouncilLoadingState, MafiaCameraMode, MafiaDioramaFrame } from './mafia-diorama';

interface Props {
  seats: SeatInfo[];
  phase: Phase;
  humanSeatId: string | null;
  chat: ChatLine[];
  previews?: Record<string, string>;
  snapCamera?: boolean;
}

export default function MafiaScene({ seats, phase, humanSeatId, chat, previews, snapCamera = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MafiaDiorama | null>(null);
  const [mode, setMode] = useState<MafiaCameraMode>('cinematic');
  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<CouncilLoadingState>({ loaded: 0, total: seats.length });
  const [retry, setRetry] = useState(0);
  const seatKey = JSON.stringify(seats.map(({ id, name, modelId }) => [id, name, modelId]));
  const state = mafiaSceneState(phase, seats, chat, previews);
  const focusSeatId = selectedSeatId ?? state.speakingSeatId ?? state.activeSeatId;
  const frameRef = useRef<MafiaDioramaFrame | null>(null);
  frameRef.current = { seats, phase, mode, focusSeatId, selectedSeatId, snapCamera, speakingSeatId: state.speakingSeatId };

  useEffect(() => {
    const canvas = canvasRef.current;
    const initialFrame = frameRef.current;
    if (!canvas || !initialFrame) return;
    try {
      const engine = new MafiaDiorama(canvas, initialFrame, (seatId) => {
        setSelectedSeatId((current) => (current === seatId ? null : seatId));
        setMode('cinematic');
      }, setLoading);
      engineRef.current = engine;
      setError(null);
      return () => {
        engine.dispose();
        engineRef.current = null;
      };
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'WebGL is unavailable on this device.');
    }
  }, [seatKey, retry]);

  useEffect(() => {
    if (frameRef.current) engineRef.current?.update(frameRef.current);
  }, [seats, phase, mode, focusSeatId, selectedSeatId, snapCamera, state.speakingSeatId]);

  const selectedSeat = seats.find((seat) => seat.id === selectedSeatId);
  const speaker = seats.find((seat) => seat.id === state.speakerId);
  const { dialogue } = state;
  const phaseTitle = useMemo(() => phaseTitleFor(phase), [phase]);

  return (
    <section className={`mafia-scene${state.night ? ' is-night' : ' is-day'}${error ? ' unavailable' : ''}`} aria-label={`3D Mafia council chamber — ${state.night ? 'night' : 'day'}`}>
      <canvas ref={canvasRef} aria-label="Interactive 3D council table. Select a character to focus the camera." />
      <div className="scene-vignette" />
      {!error && (loading.error || loading.loaded < loading.total) && (
        <div className="scene-loading" role="status">
          {loading.error ? <>
            <span>Could not load the council characters.</span>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button>
          </> : <span>Loading council characters… {loading.loaded}/{loading.total}</span>}
        </div>
      )}

      <div className="scene-topbar">
        <div className="scene-location">
          <span className="scene-kicker">COUNCIL CHAMBER // {phaseTitle}{phase.round !== undefined ? ` · ROUND ${phase.round}` : ''}</span>
          <strong>
            {selectedSeat
              ? selectedSeat.name
              : phaseTitle === 'NIGHT CYCLE'
                 ? 'The town sleeps'
                : 'The council assembly'}
          </strong>
          <small>
            {selectedSeat
              ? `${selectedSeat.alive === false ? 'Eliminated' : state.activeIds.includes(selectedSeat.id) ? state.night ? 'Awake tonight' : 'Has the floor' : state.night ? 'Asleep' : 'Listening'} · ${
                  selectedSeat.id === humanSeatId
                    ? 'Your seat'
                    : selectedSeat.modelId
                      ? shortModel(selectedSeat.modelId)
                      : 'Human seat'
                }`
              : 'An original real-time 3D Mafia table'}
          </small>
          <span className="scene-phase-badge" role="status">
            <span aria-hidden="true">{state.night ? '☾' : '☀'}</span>
            {phase.id === 'night' ? 'Waiting for dawn' : phase.label}
          </span>
        </div>
        <div className="scene-camera" aria-label="Camera mode">
          <button
            type="button"
            className={mode === 'cinematic' ? 'active' : ''}
            onClick={() => setMode('cinematic')}
            aria-pressed={mode === 'cinematic'}
          >
            Cinematic
          </button>
          <button
            type="button"
            className={mode === 'tactical' ? 'active' : ''}
            onClick={() => {
              setSelectedSeatId(null);
              setMode('tactical');
            }}
            aria-pressed={mode === 'tactical'}
          >
            Tactical
          </button>
          <select
            className="scene-seat-select"
            value={selectedSeatId ?? ''}
            aria-label="Focus a 3D seat"
            title="Focus a seat"
            onChange={(event) => {
              setSelectedSeatId(event.target.value || null);
              if (event.target.value) setMode('cinematic');
            }}
          >
            <option value="">Focus a seat…</option>
            {seats.map((seat) => (
              <option key={seat.id} value={seat.id}>{seat.name}</option>
            ))}
          </select>
        </div>
      </div>

      {selectedSeat && (
        <button type="button" className="scene-follow" onClick={() => setSelectedSeatId(null)}>
          Follow the action
        </button>
      )}

      {dialogue && speaker ? (
        <div className="scene-dialogue">
          <div className="scene-dialogue-meta">
            <span style={{ background: seatColor(speaker.id) }} />
            <strong>{speaker.name}</strong>
            <small>
              {state.channel}
            </small>
          </div>
          <p>
            {dialogue}
            {state.speakingSeatId && <span className="scene-caret">▍</span>}
          </p>
        </div>
      ) : (
        <div className="scene-dialogue quiet">
          <div className="scene-dialogue-meta">
            <span />
            <strong>{speaker?.name ?? (state.night ? 'While the town sleeps' : 'The council')}</strong>
            <small>{state.night ? 'Night watch' : speaker ? 'Considering the next move' : phase.label}</small>
          </div>
          <p>{state.night ? mafiaNightMessage(phase) : speaker ? 'The chamber waits for a decision.' : 'Every silence is part of the game.'}</p>
        </div>
      )}

      <div className="scene-help">DRAG TO ORBIT · SCROLL TO ZOOM · SELECT A SEAT TO FOCUS</div>

      {error && (
        <div className="scene-error">
          <strong>3D view unavailable</strong>
          <p>The complete 2D table remains available below.</p>
          <small>{error}</small>
        </div>
      )}
    </section>
  );
}

function phaseTitleFor(phase: Phase): string {
  const value = `${phase.id} ${phase.label}`.toLowerCase();
  if (mafiaPhaseIsNight(phase)) return 'NIGHT CYCLE';
  if (value.includes('vote')) return 'JUDGMENT';
  if (value.includes('discussion') || value.includes('day') || value.includes('dawn')) return 'DAY CYCLE';
  return 'ACTIVE SESSION';
}
