import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AppConfig, AppStatus, ModelInfo, SeatConfig } from '../shared/api';

type Screen = 'table' | 'leaderboard' | 'settings';

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('table');

  const refreshStatus = useCallback(async () => {
    setStatus(await window.gametable.status());
  }, []);

  useEffect(() => {
    void (async () => {
      const [initialStatus, initialConfig] = await Promise.all([
        window.gametable.status(),
        window.gametable.loadConfig(),
      ]);
      setStatus(initialStatus);
      setConfig(initialConfig);
    })();
  }, []);

  useEffect(() => {
    if (!status?.hasKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.gametable.listModels(false);
        if (!cancelled) setModels(result.models);
      } catch (error) {
        if (!cancelled) setModelsError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status?.hasKey]);

  const updateConfig = useCallback(async (next: AppConfig) => {
    setConfig(next);
    await window.gametable.saveConfig(next);
  }, []);

  if (!status || !config) return <Splash />;

  if (!status.hasKey) {
    return (
      <KeyGate
        onAccepted={async () => {
          await refreshStatus();
        }}
      />
    );
  }

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">
          <span className="brand-mark">♠</span>
          <div>
            <strong>GameTable</strong>
            <small>one human · ten minds</small>
          </div>
        </div>
        <RailButton active={screen === 'table'} onClick={() => setScreen('table')} icon="▦">
          Table
        </RailButton>
        <RailButton
          active={screen === 'leaderboard'}
          onClick={() => setScreen('leaderboard')}
          icon="★"
        >
          Leaderboard
        </RailButton>
        <RailButton active={screen === 'settings'} onClick={() => setScreen('settings')} icon="⚙">
          Settings
        </RailButton>
        <div className="rail-foot">
          <span className="dot" /> OpenRouter connected
          <small>{status.keyInfo?.label ?? 'personal key'}</small>
        </div>
      </nav>

      <main className="panel">
        {screen === 'table' && (
          <TableSetup
            config={config}
            models={models}
            modelsError={modelsError}
            onChange={updateConfig}
            onRefreshModels={async (refresh) => {
              const result = await window.gametable.listModels(refresh);
              setModels(result.models);
              setModelsError(null);
            }}
          />
        )}
        {screen === 'leaderboard' && <Leaderboard />}
        {screen === 'settings' && (
          <Settings
            status={status}
            config={config}
            onChange={updateConfig}
            onDisconnect={async () => {
              await window.gametable.clearKey();
              await refreshStatus();
            }}
          />
        )}
      </main>
    </div>
  );
}

function Splash() {
  return (
    <div className="splash">
      <span className="spinner" />
      <p>Laying the table…</p>
    </div>
  );
}

function KeyGate({ onAccepted }: { onAccepted: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await window.gametable.setKey(key);
      if (!result.ok) {
        setError(result.error ?? 'Could not verify that key');
        return;
      }
      await onAccepted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand large">
          <span className="brand-mark">♠</span>
          <div>
            <strong>GameTable</strong>
            <small>one human · ten minds</small>
          </div>
        </div>
        <h1>Bring your own OpenRouter key</h1>
        <p className="muted">
          Every model at this table is billed to your own key, at OpenRouter's prices. The key is
          stored on this machine only and never leaves the main process.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="key">API key</label>
          <input
            id="key"
            type="password"
            autoFocus
            placeholder="sk-or-v1-…"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            spellCheck={false}
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" className="primary" disabled={busy || key.trim().length < 8}>
            {busy ? 'Verifying…' : 'Connect'}
          </button>
        </form>
        <p className="fineprint">
          Create a key at <span className="link">openrouter.ai/keys</span>. A key with a spending
          limit is a good idea.
        </p>
      </div>
    </div>
  );
}

function RailButton(props: {
  active: boolean;
  onClick: () => void;
  icon: string;
  children: ReactNode;
}) {
  return (
    <button className={`rail-button${props.active ? ' active' : ''}`} onClick={props.onClick}>
      <span className="rail-icon">{props.icon}</span>
      {props.children}
    </button>
  );
}

function TableSetup(props: {
  config: AppConfig;
  models: ModelInfo[];
  modelsError: string | null;
  onChange: (config: AppConfig) => Promise<void>;
  onRefreshModels: (refresh: boolean) => Promise<void>;
}) {
  const { config, models, onChange } = props;
  const [picking, setPicking] = useState(false);

  const seatLabel = (seat: SeatConfig, index: number) => {
    const model = models.find((m) => m.id === seat.modelId);
    return model?.name ?? seat.modelId;
  };

  const setSeats = (seats: SeatConfig[]) => void onChange({ ...config, seats });

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>The table</h1>
          <p className="muted">
            You plus up to ten models. Mafia seats up to eleven; Buckshot is a duel and a gauntlet.
          </p>
        </div>
        <div className="head-actions">
          <button className="ghost" onClick={() => void props.onRefreshModels(true)}>
            Refresh models
          </button>
        </div>
      </header>

      <div className="table-grid">
        <SeatCard
          name={config.humanName}
          subtitle="Human seat"
          badge="YOU"
          human
          onName={(name) => void onChange({ ...config, humanName: name })}
        />
        {config.seats.map((seat, index) => (
          <SeatCard
            key={`${seat.modelId}-${index}`}
            name={seatLabel(seat, index)}
            subtitle={seat.modelId}
            badge={`AI ${index + 1}`}
            persona={seat.persona}
            onPersona={(persona) => {
              const seats = [...config.seats];
              seats[index] = { ...seat, persona };
              setSeats(seats);
            }}
            onRemove={() => setSeats(config.seats.filter((_, i) => i !== index))}
          />
        ))}
        {config.seats.length < 10 && (
          <button className="seat-card add" onClick={() => setPicking(true)}>
            <span className="plus">+</span>
            <span>Add a model</span>
            <small>{10 - config.seats.length} seats left</small>
          </button>
        )}
      </div>

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

      <section className="callout">
        <div>
          <strong>Rules engines are next.</strong>
          <p className="muted">
            The referee, projection layer and OpenRouter gateway are in place. Mafia/Werewolf and
            Buckshot Roulette rule sets are the next milestone, after which this button starts a
            real match.
          </p>
        </div>
        <button className="primary" disabled>
          Deal me in
        </button>
      </section>
    </div>
  );
}

function SeatCard(props: {
  name: string;
  subtitle: string;
  badge: string;
  human?: boolean;
  persona?: string;
  onName?: (name: string) => void;
  onPersona?: (persona: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`seat-card${props.human ? ' human' : ''}`}>
      <div className="seat-top">
        <span className="badge">{props.badge}</span>
        {props.onRemove && (
          <button className="icon" onClick={props.onRemove} aria-label="Remove seat">
            ×
          </button>
        )}
      </div>
      {props.human ? (
        <input
          className="name-input"
          value={props.name}
          onChange={(event) => props.onName?.(event.target.value)}
          aria-label="Your name"
        />
      ) : (
        <strong className="seat-name">{props.name}</strong>
      )}
      <small className="seat-sub">{props.subtitle}</small>
      {props.onPersona && (
        <input
          className="persona-input"
          placeholder="play style (optional)"
          value={props.persona ?? ''}
          onChange={(event) => props.onPersona?.(event.target.value)}
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
  const [toolsOnly, setToolsOnly] = useState(true);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.models
      .filter((m) => (freeOnly ? m.free : true))
      .filter((m) => (toolsOnly ? m.supportedParameters.includes('structured_outputs') || m.supportedParameters.includes('response_format') : true))
      .filter((m) => (!q ? true : `${m.name} ${m.id}`.toLowerCase().includes(q)))
      .sort((a, b) => Number(a.free) - Number(b.free) || a.name.localeCompare(b.name))
      .slice(0, 200);
  }, [props.models, query, freeOnly, toolsOnly]);

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
              checked={toolsOnly}
              onChange={(event) => setToolsOnly(event.target.checked)}
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

function Leaderboard() {
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Leaderboard</h1>
          <p className="muted">
            Bradley–Terry ratings, per game, adjusted for seat count and role. Buckshot adds an
            exact-optimality column: EV lost per decision.
          </p>
        </div>
      </header>
      <div className="empty-state">
        <span className="big">★</span>
        <h2>No matches yet</h2>
        <p className="muted">
          Ratings appear once models have played each other here. Everything stays on this machine
          unless you export a match.
        </p>
      </div>
    </div>
  );
}

function Settings(props: {
  status: AppStatus;
  config: AppConfig;
  onChange: (config: AppConfig) => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const usage = props.status.keyInfo?.usage ?? 0;
  const limit = props.status.keyInfo?.limit;
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Key, budget and storage.</p>
        </div>
      </header>

      <section className="settings-card">
        <h2>OpenRouter key</h2>
        <dl>
          <dt>Label</dt>
          <dd>{props.status.keyInfo?.label ?? 'unnamed'}</dd>
          <dt>Used</dt>
          <dd>
            ${usage.toFixed(2)}
            {typeof limit === 'number' ? ` of $${limit.toFixed(2)}` : ' (no limit set)'}
          </dd>
          <dt>Stored as</dt>
          <dd>{props.status.storage === 'file' ? '0600 file in the app config dir' : 'portal secret'}</dd>
        </dl>
        <button className="ghost danger" onClick={() => void props.onDisconnect()}>
          Forget key
        </button>
      </section>

      <section className="settings-card">
        <h2>Budget</h2>
        <p className="muted">A match pauses when it reaches this ceiling.</p>
        <label className="budget">
          <span>$</span>
          <input
            type="number"
            min={0}
            step={0.25}
            value={props.config.budgetUsd}
            onChange={(event) =>
              void props.onChange({ ...props.config, budgetUsd: Number(event.target.value) })
            }
          />
          <span className="muted">per match</span>
        </label>
      </section>
    </div>
  );
}

function formatContext(tokens: number): string {
  if (!tokens) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  return `${Math.round(tokens / 1000)}k ctx`;
}

function formatPrice(prompt: number, completion: number): string {
  const inUsd = prompt * 1_000_000;
  const outUsd = completion * 1_000_000;
  if (inUsd === 0 && outUsd === 0) return '$0';
  return `$${trim(inUsd)}/$${trim(outUsd)} per M`;
}

function trim(value: number): string {
  if (value < 0.01) return value.toFixed(4);
  if (value < 1) return value.toFixed(2);
  return value.toFixed(1);
}
