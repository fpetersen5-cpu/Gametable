import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppConfig,
  AppStatus,
  GameInfo,
  ModelInfo,
  ResumableMatch,
  SeatConfig,
  SeatTestResult,
  StartMatchRequest,
  VoicePreset,
} from '../../shared/api';
import { shortModel } from '../game-data';
import { Icon } from '../components/Icon';

interface Props {
  config: AppConfig;
  status: AppStatus;
  models: ModelInfo[];
  modelsError: string | null;
  games: GameInfo[];
  onChange: (config: AppConfig) => Promise<void>;
  onRefreshModels: (refresh: boolean) => Promise<void>;
  onOpenSettings: () => void;
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
  const [testing, setTesting] = useState(false);
  const [checks, setChecks] = useState<
    Record<number, { testing?: boolean; result?: SeatTestResult }>
  >({});
  const [localPicking, setLocalPicking] = useState(false);
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
    if (seat.provider === 'local') return sum;
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
        ...(seat.provider ? { provider: seat.provider } : {}),
        ...(seat.baseUrl ? { baseUrl: seat.baseUrl } : {}),
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

  const setSeats = (seats: SeatConfig[]) => {
    setChecks({});
    void onChange({ ...config, seats });
  };

  const testSeats = async () => {
    if (config.seats.length === 0) return;
    setError(null);
    setTesting(true);
    setChecks(
      Object.fromEntries(config.seats.map((_, index) => [index, { testing: true }])),
    );
    try {
      const results = await window.gametable.testSeats(
        config.seats.map((seat) => ({
          name: seatName(seat),
          modelId: seat.modelId,
          ...(seat.provider ? { provider: seat.provider } : {}),
          ...(seat.baseUrl ? { baseUrl: seat.baseUrl } : {}),
        })),
      );
      setChecks(
        Object.fromEntries(results.map((result, index) => [index, { result }])),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Seat test failed');
      setChecks({});
    } finally {
      setTesting(false);
    }
  };

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
    <div className="stack setup-screen">
      <header className="page-head">
        <div>
          <span className="eyebrow">NEW MATCH</span>
          <h1>Set the table.</h1>
          <p className="muted">
            Choose your game, seat your rivals, and let the mind games begin.
          </p>
        </div>
        <div className="head-actions">
          <button
            className="ghost"
            onClick={() => void testSeats()}
            disabled={testing || config.seats.length === 0}
          >
            <Icon name="shield" size={15} />
            {testing ? 'Testing seats…' : 'Test connections'}
          </button>
          <button
            className="ghost"
            onClick={() => void props.onRefreshModels(true)}
            disabled={!props.status.hasKey}
          >
            <Icon name="refresh" size={15} />
            Refresh models
          </button>
        </div>
      </header>

      {!props.status.hasKey && (
        <section className="callout">
          <div>
            <strong>OpenRouter is not connected</strong>
            <p className="muted">
              Local model seats work without a key. Add an OpenRouter key in Settings to use cloud
              models.
            </p>
          </div>
          <button className="ghost" onClick={props.onOpenSettings}>
            Open Settings
          </button>
        </section>
      )}

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

      <section className="setup-section game-section">
        <div className="section-heading">
          <div className="section-title">
            <span className="section-step">01</span>
            <div>
              <h2>Choose your game</h2>
              <p className="muted">Every table has its own kind of trouble.</p>
            </div>
          </div>
          <label className="spectate-toggle">
            <input
              type="checkbox"
              checked={spectator}
              onChange={(event) => setSpectator(event.target.checked)}
            />
            <span className="toggle-track"><span /></span>
            <span>
              <strong>Spectator mode</strong>
              <small>Watch AI vs AI · reveal everything</small>
            </span>
          </label>
        </div>
        <div className="game-picker">
          {games.map((entry) => (
            <button
              key={entry.id}
              className={`game-card${entry.id === gameId ? ' selected' : ''}`}
              onClick={() => setGameId(entry.id)}
              aria-pressed={entry.id === gameId}
            >
              <span className={`game-glyph${entry.capabilities.items ? ' tactics' : ''}`}>
                <Icon name={entry.capabilities.items ? 'match' : 'cards'} size={24} />
              </span>
              <span className="game-card-copy">
                <span className="game-kind">
                  {entry.capabilities.items ? 'RISK & TACTICS' : entry.capabilities.chat ? 'SOCIAL DEDUCTION' : 'STRATEGY'}
                </span>
                <strong>{entry.name}</strong>
                <small>
                  {entry.minSeats === entry.maxSeats
                    ? `${entry.minSeats} players`
                    : `${entry.minSeats}–${entry.maxSeats} players`}
                  {entry.capabilities.solver ? ' · Solver scored' : ''}
                </small>
              </span>
              <span className="game-selected"><Icon name="check" size={13} /></span>
            </button>
          ))}
        </div>
      </section>

      <section className="setup-section seats-section">
        <div className="section-heading">
          <div className="section-title">
            <span className="section-step">02</span>
            <div>
              <h2>Fill the seats</h2>
              <p className="muted">Mix cloud and local models. Give each rival its own personality.</p>
            </div>
          </div>
          <span className="seat-count"><Icon name="users" size={15} /> {totalSeats} at the table</span>
        </div>
        <div className="table-grid">
        {!spectator && (
          <div className="seat-card human">
            <div className="seat-top">
              <span className="badge">SEAT 01 · YOU</span>
              <span className="seat-ready"><span /> Ready</span>
            </div>
            <div className="seat-identity">
              <span className="seat-avatar">{config.humanName.trim().charAt(0).toUpperCase() || 'Y'}</span>
              <div>
                <input
                  className="name-input"
                  value={config.humanName}
                  onChange={(event) => void onChange({ ...config, humanName: event.target.value })}
                  aria-label="Your name"
                />
                <small className="seat-sub">The human at the table</small>
              </div>
            </div>
            <div className="human-note">
              <Icon name="shield" size={16} />
              <span>Your seat. Your decisions. No hidden information.</span>
            </div>
          </div>
        )}

        {config.seats.map((seat, index) => (
          <div key={`${seat.modelId}-${index}`} className="seat-card">
            <div className="seat-top">
              <span className="badge">SEAT {String(index + (spectator ? 1 : 2)).padStart(2, '0')}</span>
              <span className={`pill ${seat.provider === 'local' ? 'free' : ''}`}>
                {seat.provider === 'local' ? 'Local' : 'Cloud'}
              </span>
              <button
                className="icon"
                aria-label="Remove seat"
                title="Remove seat"
                onClick={() => setSeats(config.seats.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
            <div className="seat-identity">
              <span className="seat-avatar">{seatName(seat).trim().charAt(0).toUpperCase() || 'A'}</span>
              <div>
                <strong className="seat-name">{seatName(seat)}</strong>
                <small className="seat-sub" title={seat.modelId}>
                  {seat.modelId}
                </small>
              </div>
            </div>
            <input
              className="persona-input"
              placeholder="Personality, e.g. calm and analytical"
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
              placeholder="Seat budget cap (USD)"
              aria-label={`Budget cap for AI seat ${index + 1}`}
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
            {checks[index]?.testing && <small className="seat-check">Testing connection…</small>}
            {checks[index]?.result && (
              <small className={`seat-check ${checks[index]?.result?.ok ? 'ok' : 'bad'}`}>
                {checks[index]?.result?.ok
                  ? `${checks[index]?.result?.structured ? 'ready' : 'reachable, no structured JSON'} · ${
                      checks[index]?.result?.latencyMs
                    } ms`
                  : `${checks[index]?.result?.kind ?? 'error'}: ${checks[index]?.result?.message ?? 'failed'}`}
              </small>
            )}
          </div>
        ))}

        {config.seats.length < 10 && (
          <div className="seat-card add">
            <span className="plus"><Icon name="plus" size={25} /></span>
            <strong>Add a rival</strong>
            <small>Choose another mind for the table</small>
            <div className="add-seat-actions">
              <button className="ghost" onClick={() => setPicking(true)}>
                OpenRouter
              </button>
              <button className="ghost" onClick={() => setLocalPicking(true)}>
                Local model
              </button>
            </div>
            <small>{10 - config.seats.length} AI seats left</small>
          </div>
        )}
        </div>
      </section>

      <section className="callout launch-card">
        <div className="launch-copy">
          <span className="eyebrow">YOUR TABLE IS WAITING</span>
          <strong>
            {game ? `${game.name} · ${totalSeats} players` : 'Choose a game'}
          </strong>
          <p className="muted">
            {spectator
              ? 'Every role, hand and chamber will be visible.'
              : `You versus ${config.seats.length} model${config.seats.length === 1 ? '' : 's'}.`}{' '}
            Estimated match cost ≈ ${estimate.toFixed(2)}.
            {estimate > config.budgetUsd && (
              <strong className="estimate-warn"> The estimate exceeds your budget, so the match may stop early.</strong>
            )}
          </p>
          {error && <p className="error">{error}</p>}
          {!error && seatIssue && <p className="error">{seatIssue}</p>}
        </div>
        <div className="launch-action">
          <div className="launch-budget">
            <span>Match budget</span>
            <strong>${config.budgetUsd.toFixed(2)}</strong>
          </div>
          <button
            className="primary"
            onClick={() => void start()}
            disabled={starting || !game || Boolean(seatIssue)}
          >
            {starting ? 'Dealing…' : spectator ? 'Watch the match' : 'Deal me in'}
            {!starting && <Icon name="arrow" size={17} />}
          </button>
        </div>
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

      {localPicking && (
        <LocalModelPicker
          endpoint={config.localEndpoint}
          onClose={() => setLocalPicking(false)}
          onPick={(model, endpoint) => {
            setChecks({});
            setError(null);
            try {
              const url = new URL(endpoint);
              if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
            } catch {
              setError('Local endpoints must be http or https URLs.');
              return;
            }
            void onChange({
              ...config,
              localEndpoint: endpoint,
              seats: [
                ...config.seats,
                { modelId: model.id, provider: 'local', baseUrl: endpoint },
              ],
            })
              .then(() => setLocalPicking(false))
              .catch((failure: unknown) =>
                setError(failure instanceof Error ? failure.message : 'Invalid local endpoint'),
              );
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

function LocalModelPicker(props: {
  endpoint: string;
  onPick: (model: ModelInfo, endpoint: string) => void;
  onClose: () => void;
}) {
  const [endpoint, setEndpoint] = useState(props.endpoint);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.gametable.listLocalModels(endpoint);
      setModels(result.models);
      if (result.error) setError(result.error);
    } catch (failure) {
      setModels([]);
      setError(failure instanceof Error ? failure.message : 'Could not reach that endpoint');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Load once for the endpoint carried in by the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = models.filter((model) =>
    !query.trim() ? true : `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>Add a local model</h2>
          <button className="icon" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="muted">
          Ollama and other OpenAI-compatible servers. The endpoint is contacted by the main process.
        </p>
        <div className="filters">
          <input
            aria-label="Local endpoint"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            spellCheck={false}
          />
          <button className="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="filters">
          <input
            placeholder="Filter models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="model-list">
          {filtered.map((model) => (
            <li key={model.id}>
              <button className="model-row" onClick={() => props.onPick(model, endpoint)}>
                <div className="model-main">
                  <strong>{model.name}</strong>
                  <small>{model.id}</small>
                </div>
                <div className="model-meta">
                  <span>{model.contextLength ? formatContext(model.contextLength) : 'local'}</span>
                  <span className="pill free">$0</span>
                </div>
              </button>
            </li>
          ))}
          {!loading && filtered.length === 0 && (
            <li className="empty">No models discovered. You can add a model id manually.</li>
          )}
        </ul>
        <div className="filters">
          <input
            placeholder="Model id, e.g. llama3.1:8b"
            value={manual}
            onChange={(event) => setManual(event.target.value)}
          />
          <button
            className="primary"
            disabled={!manual.trim()}
            onClick={() =>
              props.onPick(
                {
                  id: manual.trim(),
                  name: manual.trim(),
                  description: `Local model at ${endpoint}`,
                  contextLength: 0,
                  promptPrice: 0,
                  completionPrice: 0,
                  supportedParameters: ['structured_outputs', 'response_format'],
                  free: true,
                },
                endpoint,
              )
            }
          >
            Add id
          </button>
        </div>
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
