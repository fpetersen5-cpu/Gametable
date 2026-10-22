import type { AppConfig, AppStatus } from '../../shared/api';

interface Props {
  status: AppStatus;
  config: AppConfig;
  onChange: (config: AppConfig) => Promise<void>;
  onDisconnect: () => Promise<void>;
}

export function SettingsScreen({ status, config, onChange, onDisconnect }: Props) {
  const usage = status.keyInfo?.usage ?? 0;
  const limit = status.keyInfo?.limit;

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Key, budget and local data.</p>
        </div>
      </header>

      <section className="settings-card">
        <h2>OpenRouter key</h2>
        <dl>
          <dt>Label</dt>
          <dd>{status.keyInfo?.label ?? 'unnamed'}</dd>
          <dt>Used</dt>
          <dd>
            ${usage.toFixed(2)}
            {typeof limit === 'number' ? ` of $${limit.toFixed(2)}` : ' (no limit set)'}
          </dd>
          <dt>Stored as</dt>
          <dd>
            {status.storage === 'keyring'
              ? 'OS keyring (encrypted with safeStorage)'
              : '0600 file in the app config dir (no keyring available)'}
          </dd>
        </dl>
        <button className="ghost danger" onClick={() => void onDisconnect()}>
          Forget key
        </button>
      </section>

      <section className="settings-card">
        <h2>Match defaults</h2>
        <p className="muted">Applied to new matches; each match can still be adjusted live.</p>
        <label className="budget">
          <span>$</span>
          <input
            type="number"
            min={0}
            step={0.25}
            value={config.budgetUsd}
            onChange={(event) =>
              void onChange({ ...config, budgetUsd: Number(event.target.value) })
            }
          />
          <span className="muted">budget per match</span>
        </label>
        <label className="budget">
          <span className="muted">AI speed</span>
          <select
            value={config.speed}
            onChange={(event) => void onChange({ ...config, speed: Number(event.target.value) })}
          >
            {[0.5, 1, 2, 4, 8].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="settings-card">
        <h2>Voice</h2>
        <p className="muted">
          Models read their messages aloud, each seat with its own synthesised voice.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={config.voice}
            onChange={(event) => void onChange({ ...config, voice: event.target.checked })}
          />
          Read model messages aloud
        </label>
      </section>

      <section className="settings-card">
        <h2>Local data</h2>
        <p className="muted">
          Keys, replays and results stay in this machine's application data directory. Nothing is
          uploaded except your OpenRouter requests.
        </p>
        <button className="ghost" onClick={() => void window.gametable.openDataFolder()}>
          Open data folder
        </button>
      </section>
    </div>
  );
}
