import { useMemo, useRef, useState } from 'react';
import type {
  AppConfig,
  GameInfo,
  ModelInfo,
  ResumableMatch,
  SeatConfig,
  StartMatchRequest,
  VoicePreset,
} from '../../shared/api';
import { shortModel } from '../game-data';

interface Props {
  config: AppConfig;
  models: ModelInfo[];
  modelsError: string | null;
  games: GameInfo[];
  onChange: (config: AppConfig) => Promise<void>;
  onRefreshModels: (refresh: boolean) => Promise<void>;
  onStart: (request: StartMatchRequest) => Promise<{ ok: boolean; error?: string }>;
  resumable: ResumableMatch[];
  voices: VoicePreset[];
  onResume: (matchId: string) => Promise<void>;
}

export function TableSetup(props: Props) {
  const { config, models, games, onChange } = props;
  const [gameId, setGameId] = useState(games[0]?.id ?? '');
  const [spectator, setSpectator] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);

  const game = games.find((entry) => entry.id === gameId) ?? games[0];
  const totalSeats = (spectator ? 0 : 1) + config.seats.length;
  const seatIssue =
    game && (totalSeats < game.minSeats || totalSeats > game.maxSeats)
      ? `${game.name} needs ${game.minSeats}–${game.maxSeats} seats; you have ${totalSeats}. ` +
        (game.minSeats === game.maxSeats
          ? `Remove ${Math.abs(totalSeats - game.maxSeats)} seat${
              Math.abs(totalSeats - game.maxSeats) === 1 ? '' : 's'
            }.`
          : '')
      : null;

  const seatName = (seat: SeatConfig) =>
    models.find((model) => model.id === seat.modelId)?.name ?? shortModel(seat.modelId);

  const estimate = config.seats.reduce((sum, seat) => {
    const model = models.find((entry) => entry.id === seat.modelId);
    if (!model) return sum;
    // Rough: ~16 calls per seat, 1.6k prompt + 220 completion tokens each.
    return sum + 16 * (model.promptPrice * 1600 + model.completionPrice * 220);
  }, 0);

  const start = async () => {
    if (!game) return;
    setError(null);
    const seats: StartMatchRequest['seats'] = [];
    if (!spectator) seats.push({ name: config.humanName, kind: 'human' });
    for (const seat of config.seats) {
      seats.push({
        name: seatName(seat),
        kind: 'llm',
        modelId: seat.modelId,
        ...(seat.persona ? { persona: seat.persona } : {}),
        ...(seat.voice === undefined ? {} : { voice: seat.voice }),
        ...(seat.budgetUsd ? { budgetUsd: seat.budgetUsd } : {}),
      });
    }
    if (seats.length < game.minSeats || seats.length > game.maxSeats) {
      setError(`${game.name} needs ${game.minSeats}–${game.maxSeats} seats; you have ${seats.length}.`);
      return;
    }
    setStarting(true);
    try {
      const result = await props.onStart({
        gameId: game.id,
        seats,
        budgetUsd: config.budgetUsd,
        speed: config.speed,
        trackOptimality: game.capabilities.solver,
      });
      if (!result.ok) setError(result.error ?? 'Could not start the match');
    } finally {
      setStarting(false);
    }
  };

  const setSeats = (seats: SeatConfig[]) => void onChange({ ...config, seats });

  const previewVoice = async (index: number, seat: SeatConfig) => {
    previewAudio.current?.pause();
    setPreviewing(index);
    try {
      const result = await window.gametable.speak(
        `Hi, I'm ${seatName(seat)}. This is my voice at this table.`,
        `s${index + 1}`,
        seat.voice,
      );
      if (!result.audio) return;
      const player = new Audio(`data:audio/wav;base64,${result.audio}`);
      previewAudio.current = player;
      await new Promise<void>((resolve) => {
        player.onended = () => resolve();
        player.onerror = () => resolve();
        void player.play().catch(() => resolve());
      });
    } finally {
      setPreviewing(null);
    }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>The table</h1>
          <p className="muted">
            One human against up to ten models, each on your own OpenRouter key.
          </p>
        </div>
        <div className="head-actions">
          <button className="ghost" onClick={() => void props.onRefreshModels(true)}>
            Refresh models
          </button>
        </div>
      </header>

      {props.resumable.length > 0 && (
        <section className="resume-card">
          <div>
            <strong>Unfinished match</strong>
            <p className="muted">
              {props.resumable[0]?.gameName} · {props.resumable[0]?.eventCount} actions ·{' '}
              {new Date(props.resumable[0]?.updatedAt ?? 0).toLocaleString()}
            </p>
          </div>
          <button className="primary" onClick={() => void props.onResume(props.resumable[0]?.matchId ?? '')}>
            Resume
          </button>
        </section>
      )}

      <section className="game-picker">
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
                {entry.minSeats === entry.maxSeats
                  ? `${entry.minSeats} seats`
                  : `${entry.minSeats}–${entry.maxSeats} seats`}
                {entry.capabilities.solver ? ' · scored by solver' : ''}
              </small>
            </div>
          </button>
        ))}
        <label className="spectate-toggle">
          <input
            type="checkbox"
            checked={spectator}
            onChange={(event) => setSpectator(event.target.checked)}
          />
          <span>
            <strong>Watch AI vs AI</strong>
            <small>No human seat; the table reveals everything</small>
          </span>
        </label>
      </section>

      <div className="table-grid">
        {!spectator && (
          <div className="seat-card human">
            <div className="seat-top">
              <span className="badge">YOU</span>
            </div>
            <input
              className="name-input"
              value={config.humanName}
              onChange={(event) => void onChange({ ...config, humanName: event.target.value })}
              aria-label="Your name"
            />
            <small className="seat-sub">Human seat</small>
          </div>
        )}

        {config.seats.map((seat, index) => (
          <div key={`${seat.modelId}-${index}`} className="seat-card">
            <div className="seat-top">
              <span className="badge">AI {index + 1}</span>
              <button
                className="icon"
                aria-label="Remove seat"
                onClick={() => setSeats(config.seats.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
            <strong className="seat-name">{seatName(seat)}</strong>
            <small className="seat-sub">{seat.modelId}</small>
            <input
              className="persona-input"
              placeholder="play style (optional)"
              value={seat.persona ?? ''}
              onChange={(event) => {
                const seats = [...config.seats];
                seats[index] = { ...seat, persona: event.target.value };
                setSeats(seats);
              }}
            />
            <div className="seat-voice">
              <select
                aria-label={`Voice for AI seat ${index + 1}`}
                value={seat.voice ?? ''}
                onChange={(event) => {
                  const seats = [...config.seats];
                  seats[index] = {
                    ...seat,
                    voice: event.target.value === '' ? undefined : Number(event.target.value),
                  };
                  setSeats(seats);
                }}
              >
                <option value="">Auto voice</option>
                {props.voices.map((voice) => (
                  <option key={voice.id} value={voice.speaker}>
                    {voice.name}
                  </option>
                ))}
              </select>
              <button
                className="icon"
                title="Preview this voice"
                aria-label={`Preview voice for AI seat ${index + 1}`}
                disabled={previewing === index}
                onClick={() => void previewVoice(index, seat)}
              >
                {previewing === index ? '…' : '▶'}
              </button>
            </div>
            <input
              className="cap-input"
              type="number"
              min={0}
              step={0.05}
              placeholder="cap $ (optional)"
              value={seat.budgetUsd ?? ''}
              onChange={(event) => {
                const seats = [...config.seats];
                seats[index] = {
                  ...seat,
                  budgetUsd: event.target.value === '' ? undefined : Number(event.target.value),
                };
                setSeats(seats);
              }}
            />
          </div>
        ))}

        {config.seats.length < 10 && (
          <button className="seat-card add" onClick={() => setPicking(true)}>
            <span className="plus">+</span>
            <span>Add a model</span>
            <small>{10 - config.seats.length} seats left</small>
          </button>
        )}
      </div>

      <section className="callout">
        <div>
          <strong>
            {game ? `${game.name} · ${totalSeats} seats` : 'Choose a game'}
          </strong>
          <p className="muted">
            {spectator
              ? 'Spectator mode: every role, hand and chamber is visible.'
              : `${config.seats.length} model${config.seats.length === 1 ? '' : 's'} at the table.`}{' '}
            Budget ${config.budgetUsd.toFixed(2)} for this match · estimated ≈ $
            {estimate.toFixed(2)}.
            {estimate > config.budgetUsd && (
              <strong className="estimate-warn"> That estimate exceeds your budget — the match will stop early.</strong>
            )}
          </p>
          {error && <p className="error">{error}</p>}
          {!error && seatIssue && <p className="error">{seatIssue}</p>}
        </div>
        <button
          className="primary"
          onClick={() => void start()}
          disabled={starting || !game || Boolean(seatIssue)}
        >
          {starting ? 'Dealing…' : spectator ? 'Watch the match' : 'Deal me in'}
        </button>
      </section>

      {picking && (
        <ModelPicker
          models={models}
          error={props.modelsError}
          onClose={() => setPicking(false)}
          onPick={(model) => {
            setSeats([...config.seats, { modelId: model.id }]);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

function ModelPicker(props: {
  models: ModelInfo[];
  error: string | null;
  onPick: (model: ModelInfo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [structuredOnly, setStructuredOnly] = useState(true);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.models
      .filter((model) => (freeOnly ? model.free : true))
      .filter((model) =>
        structuredOnly
          ? model.supportedParameters.includes('structured_outputs') ||
            model.supportedParameters.includes('response_format')
          : true,
      )
      .filter((model) => (!q ? true : `${model.name} ${model.id}`.toLowerCase().includes(q)))
      .sort((a, b) => Number(a.free) - Number(b.free) || a.name.localeCompare(b.name))
      .slice(0, 200);
  }, [props.models, query, freeOnly, structuredOnly]);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>Choose a model</h2>
          <button className="icon" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="filters">
          <input
            autoFocus
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={freeOnly}
              onChange={(event) => setFreeOnly(event.target.checked)}
            />
            Free only
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={structuredOnly}
              onChange={(event) => setStructuredOnly(event.target.checked)}
            />
            Structured output
          </label>
        </div>
        {props.error && <p className="error">{props.error}</p>}
        <ul className="model-list">
          {filtered.map((model) => (
            <li key={model.id}>
              <button className="model-row" onClick={() => props.onPick(model)}>
                <div className="model-main">
                  <strong>{model.name}</strong>
                  <small>{model.id}</small>
                </div>
                <div className="model-meta">
                  <span>{formatContext(model.contextLength)}</span>
                  <span>{formatPrice(model.promptPrice, model.completionPrice)}</span>
                  {model.free && <span className="pill free">free</span>}
                </div>
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="empty">No models match that filter.</li>}
        </ul>
      </div>
    </div>
  );
}

function formatContext(tokens: number): string {
  if (!tokens) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  return `${Math.round(tokens / 1000)}k ctx`;
}

function formatPrice(prompt: number, completion: number): string {
  const input = prompt * 1_000_000;
  const output = completion * 1_000_000;
  if (input === 0 && output === 0) return '$0';
  return `$${trim(input)}/$${trim(output)} per M`;
}

function trim(value: number): string {
  if (value < 0.01) return value.toFixed(4);
  if (value < 1) return value.toFixed(2);
  return value.toFixed(1);
}
