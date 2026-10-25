import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AppConfig, AppStatus } from '../../shared/api';

interface Props {
  status: AppStatus;
  config: AppConfig;
  onChange: (config: AppConfig) => Promise<void>;
  onKeyChanged: () => Promise<void>;
  onRestored: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}

export function SettingsScreen({
  status,
  config,
  onChange,
  onKeyChanged,
  onRestored,
  onDisconnect,
}: Props) {
  const usage = status.keyInfo?.usage ?? 0;
  const limit = status.keyInfo?.limit;
  const [key, setKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState(config.localEndpoint);
  const [endpointError, setEndpointError] = useState<string | null>(null);

  useEffect(() => {
    setEndpointDraft(config.localEndpoint);
  }, [config.localEndpoint]);

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    setKeyBusy(true);
    setKeyError(null);
    setKeyNote(null);
    try {
      const result = await window.gametable.setKey(key);
      if (!result.ok) {
        setKeyError(result.error ?? 'Could not verify that key');
        return;
      }
      setKey('');
      setKeyNote('Key verified and stored.');
      await onKeyChanged();
    } finally {
      setKeyBusy(false);
    }
  };

  const exportBackup = async () => {
    setBackupBusy(true);
    setBackupNote(null);
    try {
      const result = await window.gametable.exportBackup();
      setBackupNote(result.ok ? `Saved to ${result.path}` : result.error ?? 'Export failed');
    } finally {
      setBackupBusy(false);
    }
  };

  const importBackup = async () => {
    setBackupBusy(true);
    setBackupNote(null);
    try {
      const result = await window.gametable.importBackup();
      if (!result.ok) {
        setBackupNote(result.error === 'cancelled' ? null : result.error ?? 'Restore failed');
        return;
      }
      await onRestored();
      setBackupNote(
        `Restored ${result.importedMatches ?? 0} replays and ${result.importedResults ?? 0} results` +
          `${result.legacyMatches ? `; ${result.legacyMatches} legacy replay(s)` : ''}` +
          `${result.configRestored ? '; settings replaced' : '; current settings kept'}.`,
      );
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <span className="eyebrow">PREFERENCES</span>
          <h1>Make it yours.</h1>
          <p className="muted">Connections, match defaults, voice, and your local data.</p>
        </div>
      </header>

      <div className="settings-grid">
      <section className="settings-card">
        <h2>OpenRouter key</h2>
        {status.hasKey ? (
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
        ) : (
          <p className="muted">
            Not connected. You can still play with local models; add a key for OpenRouter seats.
          </p>
        )}
        <form onSubmit={saveKey} className="key-form">
          <label htmlFor="settings-key">{status.hasKey ? 'Replace key' : 'Add key'}</label>
          <input
            id="settings-key"
            type="password"
            placeholder="sk-or-v1-…"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            spellCheck={false}
          />
          <button type="submit" className="primary" disabled={keyBusy || key.trim().length < 8}>
            {keyBusy ? 'Verifying…' : 'Save key'}
          </button>
        </form>
        {keyError && <p className="error">{keyError}</p>}
        {keyNote && <p className="muted">{keyNote}</p>}
        {status.hasKey && (
          <button className="ghost danger" onClick={() => void onDisconnect()}>
            Forget key
          </button>
        )}
      </section>

      <section className="settings-card">
        <h2>Local model endpoint</h2>
        <p className="muted">
          OpenAI-compatible server used by local seats, for example Ollama at
          <code> http://127.0.0.1:11434/v1</code>. No OpenRouter key or cloud spend is used.
        </p>
        <label className="budget wide">
          <input
            type="url"
            value={endpointDraft}
            onChange={(event) => setEndpointDraft(event.target.value)}
            spellCheck={false}
            aria-label="Local model endpoint"
          />
        </label>
        <div className="head-actions">
          <button
            className="ghost"
            onClick={async () => {
              setEndpointError(null);
              try {
                await onChange({ ...config, localEndpoint: endpointDraft });
              } catch (error) {
                setEndpointError(error instanceof Error ? error.message : 'Invalid endpoint');
                // Drop the optimistic invalid draft by reloading from disk.
                await onRestored();
              }
            }}
          >
            Save endpoint
          </button>
        </div>
        {endpointError && <p className="error">{endpointError}</p>}
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
        <h2>Backup and restore</h2>
        <p className="muted">
          A backup carries settings, results and replays. It never contains the API key, live
          matches or browser state. Replays can contain hidden roles and private chat, so the file
          is written owner-only; review it before sharing.
        </p>
        <div className="head-actions">
          <button className="ghost" onClick={() => void exportBackup()} disabled={backupBusy}>
            Export backup
          </button>
          <button className="ghost" onClick={() => void importBackup()} disabled={backupBusy}>
            Restore backup
          </button>
          <button className="ghost" onClick={() => void window.gametable.openDataFolder()}>
            Open data folder
          </button>
        </div>
        {backupNote && <p className="muted">{backupNote}</p>}
      </section>
      </div>
    </div>
  );
}
