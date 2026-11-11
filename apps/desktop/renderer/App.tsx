import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AppConfig,
  AppStatus,
  GameInfo,
  Debrief,
  MatchSummary,
  SeatPreview,
  StartMatchRequest,
  TableSnapshot,
  VoicePreset,
} from '../shared/api';
import { TableSetup } from './screens/TableSetup';
import { MatchScreen } from './screens/MatchScreen';
import { ReplayScreen } from './screens/ReplayScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ArenaScreen } from './screens/ArenaScreen';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { version } from '../package.json';
import { useResource } from './useResource';
import { withTimeout } from './async';

type Screen = 'table' | 'match' | 'arena' | 'replays' | 'leaderboard' | 'settings';

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [games, setGames] = useState<GameInfo[]>([]);
  const [screen, setScreen] = useState<Screen>('table');

  const [snapshot, setSnapshot] = useState<TableSnapshot | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [debrief, setDebrief] = useState<Debrief | null>(null);
  const [replayMatchId, setReplayMatchId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<VoicePreset[]>([]);

  const refreshStatus = useCallback(async () => {
    setStatus(await withTimeout(window.gametable.status(), 'Connection check'));
  }, []);

  const startup = useResource(useCallback(async () => {
    if (!window.gametable) throw new Error('The desktop connection is unavailable. Restart GameTable.');
    return Promise.all([
      window.gametable.status(),
      window.gametable.loadConfig(),
      window.gametable.listGames(),
      window.gametable.listVoices(),
    ]);
  }, []), 'Startup');

  useEffect(() => {
    if (!startup.data) return;
    const [initialStatus, initialConfig, initialGames, initialVoices] = startup.data;
    setStatus(initialStatus);
    setConfig(initialConfig);
    setGames(initialGames);
    setVoices(initialVoices);
  }, [startup.data]);

  useEffect(() => {
    if (!window.gametable) return;
    const offTable = window.gametable.onTable((next) => setSnapshot(next));
    const offFinished = window.gametable.onFinished((next) => setSummary(next));
    const offError = window.gametable.onMatchError((message) => setMatchError(message));
    const offDebrief = window.gametable.onDebrief((next) => setDebrief(next));
    const offPreview = window.gametable.onPreview((next: SeatPreview) => {
      setPreviews((current) => {
        if (next.text) return { ...current, [next.seatId]: next.text };
        if (!(next.seatId in current)) return current;
        const updated = { ...current };
        delete updated[next.seatId];
        return updated;
      });
    });
    return () => {
      offTable();
      offFinished();
      offError();
      offDebrief();
      offPreview();
    };
  }, []);

  const resumable = useResource(useCallback(async () => {
    if (screen !== 'table' || !status) return [];
    return window.gametable.listResumable();
  }, [screen, status]), 'Recovery history');

  const catalogue = useResource(useCallback(async () => {
    if (!status?.hasKey) return [];
    return (await window.gametable.listModels(modelRefresh > 0)).models;
  }, [status?.hasKey, modelRefresh]), 'Model catalogue');
  const models = catalogue.data ?? [];

  const updateConfig = useCallback(async (next: AppConfig) => {
    setConfig(next);
    await window.gametable.saveConfig(next);
  }, []);

  const startMatch = useCallback(async (request: StartMatchRequest) => {
    setSnapshot(null);
    setSummary(null);
    setMatchError(null);
    setExportNote(null);
    setDebrief(null);
    setPreviews({});
    const result = await window.gametable.startMatch(request);
    if (result.ok) setScreen('match');
    return result;
  }, []);

  const runMatchCommand = useCallback((work: Promise<void>) => {
    void work.catch((failure) => {
      setMatchError(failure instanceof Error ? failure.message : 'Match command failed');
    });
  }, []);

  if (!status || !config) return startup.error ? (
    <div className="splash">
      <h1>Could not start GameTable</h1>
      <p role="alert">{startup.error}</p>
      <button className="primary" onClick={startup.retry}>Retry startup</button>
      {window.gametable && <button className="ghost" onClick={() => {
        void window.gametable.openDataFolder().catch(() => undefined);
      }}>Open data folder</button>}
    </div>
  ) : <Splash />;

  const live = snapshot && snapshot.status !== 'finished' && snapshot.status !== 'aborted';

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="brand" size={24} />
          </span>
          <div>
            <strong>
              GameTable <span className="brand-version">v{version}</span>
            </strong>
            <small>AI TABLETOP CLUB</small>
          </div>
        </div>

        <div className="rail-section">
          <span className="rail-label">Play</span>
          <RailButton active={screen === 'table'} onClick={() => setScreen('table')} icon="table">
            New table
          </RailButton>
          <RailButton
            active={screen === 'match'}
            onClick={() => setScreen('match')}
            icon="match"
            disabled={!snapshot}
          >
            <span>Live match</span>
            {live && <span className="live-dot" title="Match in progress" />}
          </RailButton>
          <RailButton active={screen === 'arena'} onClick={() => setScreen('arena')} icon="arena">
            Arena
          </RailButton>
        </div>

        <div className="rail-section">
          <span className="rail-label">Your library</span>
          <RailButton
            active={screen === 'replays'}
            onClick={() => setScreen('replays')}
            icon="replay"
          >
            Replays
          </RailButton>
          <RailButton
            active={screen === 'leaderboard'}
            onClick={() => setScreen('leaderboard')}
            icon="leaderboard"
          >
            Leaderboard
          </RailButton>
        </div>

        <div className="rail-bottom">
          <RailButton
            active={screen === 'settings'}
            onClick={() => setScreen('settings')}
            icon="settings"
          >
            Settings
          </RailButton>
          <div
            className={`rail-foot${status.keyValid ? ' online' : status.hasKey ? ' bad' : ' local'}`}
          >
            <span className="status-symbol">
              <Icon name="shield" size={17} />
            </span>
            <div>
              <strong>
                {status.keyValid
                  ? 'OpenRouter connected'
                  : status.hasKey
                    ? 'Connection issue'
                    : 'Local mode ready'}
              </strong>
              <small>
                {status.keyValid
                  ? 'Cloud and local seats available'
                  : status.hasKey
                    ? 'Check your key in Settings'
                    : 'No API key required'}
              </small>
            </div>
            <span className="dot" />
          </div>
        </div>
      </nav>

      <main className={`panel${screen === 'match' || screen === 'replays' ? ' wide' : ''}`}>
        {screen === 'table' && (
          <TableSetup
            config={config}
            status={status}
            models={models}
            modelsError={catalogue.error}
            modelsLoading={catalogue.loading}
            games={games}
            onChange={updateConfig}
            onStart={startMatch}
            onOpenSettings={() => setScreen('settings')}
            resumable={resumable.data ?? []}
            resumableLoading={resumable.loading}
            resumableError={resumable.error}
            onRefreshResumable={resumable.retry}
            voices={voices}
            onResume={async (matchId) => {
              setSummary(null);
              setSnapshot(null);
              setDebrief(null);
              setMatchError(null);
              const result = await window.gametable.resumeMatch(matchId);
              if (result.ok) {
                setPreviews({});
                setScreen('match');
              } else throw new Error(result.error ?? 'Could not resume that match');
            }}
            onRefreshModels={async () => {
              setModelRefresh((value) => value + 1);
            }}
          />
        )}

        {screen === 'match' &&
          (snapshot ? (
            <MatchScreen
              snapshot={snapshot}
              summary={summary}
              error={matchError}
              exportNote={exportNote}
              debrief={debrief}
              previews={previews}
              voiceEnabled={config.voice}
              scene3dEnabled={config.scene3d}
              onVoiceChange={(voice) => runMatchCommand(updateConfig({ ...config, voice }))}
              onAction={(action) => runMatchCommand(window.gametable.submitAction(action))}
              onTakeover={(seatId) => runMatchCommand(window.gametable.takeoverSeat(seatId))}
              onRelease={(seatId) => runMatchCommand(window.gametable.releaseSeat(seatId))}
              onPause={(paused) => runMatchCommand(window.gametable.setPaused(paused))}
              onSpeed={(speed) => runMatchCommand(window.gametable.setSpeed(speed))}
              onAbort={() => runMatchCommand(window.gametable.abortMatch())}
              onRewind={() => runMatchCommand(window.gametable.rewindMatch())}
              onExit={() => {
                setScreen('table');
                if (snapshot && snapshot.status === 'running') {
                  // Keep the live snapshot so the rail can return to it, but do
                  // not let a hidden match keep spending.
                  if (!snapshot.paused) {
                    void window.gametable.setPaused(true).catch(() => undefined);
                  }
                } else {
                  setSnapshot(null);
                  setSummary(null);
                  setPreviews({});
                }
              }}
              onReplay={() => {
                setReplayMatchId(summary?.matchId ?? null);
                setScreen('replays');
              }}
              onExport={async () => {
                if (!summary) return;
                try {
                  const result = await window.gametable.exportTranscript(summary.matchId);
                  setExportNote(result.ok ? `Saved to ${result.path}` : result.error ?? 'Export failed');
                } catch (failure) {
                  setExportNote(failure instanceof Error ? failure.message : 'Export failed');
                }
              }}
            />
          ) : (
            <Splash label="Dealing the table…" />
          ))}

        {screen === 'arena' && (
          <ArenaScreen
            games={games}
            config={config}
            models={models}
            onLeaderboard={() => setScreen('leaderboard')}
          />
        )}

        {screen === 'replays' && (
          <ReplayScreen initialMatchId={replayMatchId} scene3dEnabled={config.scene3d} />
        )}

        {screen === 'leaderboard' && <LeaderboardScreen games={games} />}

        {screen === 'settings' && (
          <SettingsScreen
            status={status}
            config={config}
            onChange={updateConfig}
            onKeyChanged={refreshStatus}
            onRestored={async () => {
              setConfig(await window.gametable.loadConfig());
              await refreshStatus();
            }}
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

function Splash({ label = 'Laying the table…' }: { label?: string }) {
  return (
    <div className="splash">
      <span className="spinner" />
      <p>{label}</p>
    </div>
  );
}

function RailButton(props: {
  active: boolean;
  onClick: () => void;
  icon: IconName;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className={`rail-button${props.active ? ' active' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-current={props.active ? 'page' : undefined}
    >
      <span className="rail-icon">
        <Icon name={props.icon} size={18} />
      </span>
      <span className="rail-button-content">{props.children}</span>
    </button>
  );
}
