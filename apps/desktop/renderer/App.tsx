import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AppConfig,
  AppStatus,
  GameInfo,
  Debrief,
  MatchSummary,
  ResumableMatch,
  ModelInfo,
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

type Screen = 'table' | 'match' | 'arena' | 'replays' | 'leaderboard' | 'settings';

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [games, setGames] = useState<GameInfo[]>([]);
  const [screen, setScreen] = useState<Screen>('table');

  const [snapshot, setSnapshot] = useState<TableSnapshot | null>(null);
  const [summary, setSummary] = useState<MatchSummary | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [debrief, setDebrief] = useState<Debrief | null>(null);
  const [resumable, setResumable] = useState<ResumableMatch[]>([]);
  const [replayMatchId, setReplayMatchId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<VoicePreset[]>([]);

  const refreshStatus = useCallback(async () => {
    setStatus(await window.gametable.status());
  }, []);

  useEffect(() => {
    void (async () => {
      const [initialStatus, initialConfig, initialGames, initialVoices] = await Promise.all([
        window.gametable.status(),
        window.gametable.loadConfig(),
        window.gametable.listGames(),
        window.gametable.listVoices(),
      ]);
      setStatus(initialStatus);
      setConfig(initialConfig);
      setGames(initialGames);
      setVoices(initialVoices);
    })();
  }, []);

  useEffect(() => {
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

  useEffect(() => {
    if (screen !== 'table') return;
    void window.gametable.listResumable().then(setResumable).catch(() => setResumable([]));
  }, [screen]);

  useEffect(() => {
    if (!status?.hasKey) {
      setModels([]);
      setModelsError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.gametable.listModels(false);
        if (!cancelled) {
          setModels(result.models);
          setModelsError(null);
        }
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

  if (!status || !config) return <Splash />;

  const live = snapshot && snapshot.status !== 'finished' && snapshot.status !== 'aborted';

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">
          <span className="brand-mark">♠</span>
          <div>
            <strong>GameTable</strong>
          </div>
        </div>

        <RailButton active={screen === 'table'} onClick={() => setScreen('table')} icon="▦">
          Table
        </RailButton>
        <RailButton
          active={screen === 'match'}
          onClick={() => setScreen('match')}
          icon="✦"
          disabled={!snapshot}
        >
          Match{live ? ' •' : ''}
        </RailButton>
        <RailButton active={screen === 'arena'} onClick={() => setScreen('arena')} icon="⚔">
          Arena
        </RailButton>
        <RailButton
          active={screen === 'replays'}
          onClick={() => setScreen('replays')}
          icon="◷"
        >
          Replays
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
          <span className={`dot${status.keyValid ? '' : ' bad'}`} />{' '}
          {status.keyValid
            ? 'OpenRouter connected'
            : status.hasKey
              ? 'OpenRouter key rejected'
              : 'Local seats available'}
        </div>
      </nav>

      <main className={`panel${screen === 'match' || screen === 'replays' ? ' wide' : ''}`}>
        {screen === 'table' && (
          <TableSetup
            config={config}
            status={status}
            models={models}
            modelsError={modelsError}
            games={games}
            onChange={updateConfig}
            onStart={startMatch}
            onOpenSettings={() => setScreen('settings')}
            resumable={resumable}
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
              } else setMatchError(result.error ?? 'Could not resume that match');
            }}
            onRefreshModels={async (refresh) => {
              const result = await window.gametable.listModels(refresh);
              setModels(result.models);
              setModelsError(null);
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
              onVoiceChange={(voice) => void updateConfig({ ...config, voice })}
              onAction={(action) => void window.gametable.submitAction(action)}
              onTakeover={(seatId) => void window.gametable.takeoverSeat(seatId)}
              onRelease={(seatId) => void window.gametable.releaseSeat(seatId)}
              onPause={(paused) => void window.gametable.setPaused(paused)}
              onSpeed={(speed) => void window.gametable.setSpeed(speed)}
              onAbort={() => void window.gametable.abortMatch()}
              onRewind={() => void window.gametable.rewindMatch()}
              onExit={() => {
                setScreen('table');
                setSnapshot(null);
                setSummary(null);
                setPreviews({});
              }}
              onReplay={() => {
                setReplayMatchId(summary?.matchId ?? null);
                setScreen('replays');
              }}
              onExport={async () => {
                if (!summary) return;
                const result = await window.gametable.exportTranscript(summary.matchId);
                setExportNote(result.ok ? `Saved to ${result.path}` : result.error ?? 'Export failed');
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

        {screen === 'replays' && <ReplayScreen initialMatchId={replayMatchId} />}

        {screen === 'leaderboard' && <LeaderboardScreen />}

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
  icon: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className={`rail-button${props.active ? ' active' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      <span className="rail-icon">{props.icon}</span>
      {props.children}
    </button>
  );
}
