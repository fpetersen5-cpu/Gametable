import { useEffect, useState } from 'react';
import type { GameAction, GameView } from '../../shared/api';
import { ITEM_LABEL, ROLE_GLYPH, actionTargetName } from '../game-data';
import { useRecorder } from '../recorder';

interface Props {
  view: GameView;
  awaiting: boolean;
  onAction: (action: GameAction) => void;
}

export function ActionPanel({ view, awaiting, onAction }: Props) {
  const [text, setText] = useState('');
  const [sayTo, setSayTo] = useState('');
  const [voteText, setVoteText] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const recorder = useRecorder();
  const actions = view.legalActions;
  const actor = view.phase.actors[0];
  const actorName = view.seats.find((seat) => seat.id === actor)?.name;

  useEffect(() => {
    setText('');
    setSayTo('');
    setVoteText('');
  }, [view.phase.id, view.phase.actor, view.phase.round]);

  if (!awaiting || actions.length === 0) {
    return (
      <div className="action-panel waiting">
        <h3>Action</h3>
        <p className="muted">
          {view.terminal
            ? 'The match is over.'
            : actorName
              ? `${actorName} is thinking…`
              : 'Waiting for the table.'}
        </p>
      </div>
    );
  }

  const says = actions.filter((action) => action.type === 'say');
  const addressed = says.filter((action) => typeof action.to === 'string');
  const passes = actions.filter((action) => action.type === 'pass');
  const shoots = actions.filter((action) => action.type === 'shoot');
  const items = actions.filter((action) => action.type === 'use');
  const steals = actions.filter((action) => action.type === 'steal' && 'item' in action);
  const skips = actions.filter((action) => action.type === 'skip');
  const targetActions = actions.filter((action) =>
    ['vote', 'kill', 'investigate', 'save', 'probe'].includes(action.type),
  );
  const votes = targetActions.filter((action) => action.type === 'vote');
  const hands = actions.filter((action) => action.type === 'raise' || action.type === 'quiet');
  const handled = (action: GameAction): boolean =>
    action.type === 'say' ||
    action.type === 'pass' ||
    action.type === 'shoot' ||
    action.type === 'use' ||
    (action.type === 'steal' && 'item' in action) ||
    action.type === 'skip' ||
    action.type === 'raise' ||
    action.type === 'quiet' ||
    ['vote', 'kill', 'investigate', 'save', 'probe'].includes(action.type);
  const others = actions.filter((action) => !handled(action));

  const stopTalking = async () => {
    const wav = await recorder.stop();
    if (!wav) return;
    setTranscribing(true);
    setMicError(null);
    try {
      const result = await window.gametable.transcribe(wav);
      if (result.text) {
        setText((previous) => (previous ? `${previous} ${result.text}` : (result.text as string)));
      } else if (result.error) {
        setMicError(result.error);
      }
    } finally {
      setTranscribing(false);
    }
  };

  const submitText = () => {
    const value = text.trim();
    if (!value) return;
    onAction({
      type: 'say',
      text: value.slice(0, 600),
      ...(sayTo ? { to: sayTo } : {}),
    });
    setText('');
  };

  return (
    <div className="action-panel">
      <h3>Your move</h3>

      {says.length > 0 && (
        <div className="action-block">
          <label className="action-label">Say something</label>
          {addressed.length > 0 && (
            <select
              className="say-to"
              value={sayTo}
              onChange={(event) => setSayTo(event.target.value)}
            >
              <option value="">to everyone</option>
              {addressed.map((action) => (
                <option key={String(action.to)} value={String(action.to)}>
                  to {view.seats.find((seat) => seat.id === action.to)?.name ?? String(action.to)}
                </option>
              ))}
            </select>
          )}
          <textarea
            autoFocus
            value={text}
            maxLength={600}
            placeholder="Accuse, defend, bluff…"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitText();
              }
            }}
          />
          <div className="say-actions">
            <button
              type="button"
              className={`mic${recorder.recording ? ' recording' : ''}`}
              onPointerDown={(event) => {
                event.preventDefault();
                void recorder.start();
              }}
              onPointerUp={() => void stopTalking()}
              onPointerLeave={() => {
                if (recorder.recording) void stopTalking();
              }}
              disabled={transcribing}
            >
              {transcribing
                ? 'Transcribing…'
                : recorder.recording
                  ? '● Listening — release to use'
                  : '🎤 Hold to talk'}
            </button>
            <button className="primary" disabled={!text.trim()} onClick={submitText}>
              Speak
            </button>
          </div>
          {(micError || recorder.error) && <p className="error">{micError ?? recorder.error}</p>}
        </div>
      )}

      {hands.length > 0 && (
        <div className="action-block">
          <label className="action-label">The floor is open</label>
          <div className="action-grid two">
            {hands.map((action) => (
              <button
                key={action.type}
                className={action.type === 'raise' ? 'primary' : 'ghost'}
                onClick={() => onAction(action)}
              >
                {action.type === 'raise' ? '✋ Raise hand' : 'Stay quiet'}
              </button>
            ))}
          </div>
        </div>
      )}

      {votes.length > 0 && (
        <div className="action-block">
          <label className="action-label">Your reason (read aloud)</label>
          <textarea
            value={voteText}
            maxLength={240}
            placeholder="Why this vote? Leave it blank for a plain statement."
            onChange={(event) => setVoteText(event.target.value)}
          />
        </div>
      )}

      {targetActions.length > 0 && (
        <div className="action-block">
          <label className="action-label">
            {targetActions[0]?.type === 'vote'
              ? 'Vote to eliminate'
              : targetActions[0]?.type === 'kill'
                ? 'Choose a victim'
                : targetActions[0]?.type === 'investigate'
                  ? 'Investigate'
                  : targetActions[0]?.type === 'save'
                    ? 'Protect'
                    : 'Choose a target'}
          </label>
          <div className="action-grid">
            {targetActions.map((action) => (
              <button
                key={`${action.type}-${String(action.target)}`}
                className="action-target"
                onClick={() =>
                  onAction(
                    action.type === 'vote'
                      ? { ...action, text: voteText.trim() }
                      : action,
                  )
                }
              >
                {actionTargetName(action, view.seats)}
              </button>
            ))}
          </div>
        </div>
      )}

      {shoots.length > 0 && (
        <div className="action-block">
          <label className="action-label">Shoot</label>
          <div className="action-grid two">
            {shoots.map((action) => {
              const self = action.target === 'self';
              const targetName = self
                ? 'yourself'
                : view.seats[view.phase.actors[0] === view.seats[0]?.id ? 1 : 0]?.name ?? 'opponent';
              return (
                <button
                  key={`shoot-${String(action.target)}`}
                  className={self ? 'shoot-button self' : 'shoot-button'}
                  onClick={() => onAction(action)}
                >
                  <span>🔫</span>
                  Shoot {self ? 'yourself' : targetName}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="action-block">
          <label className="action-label">Use an item</label>
          <div className="action-grid">
            {items.map((action) => {
              const item = ITEM_LABEL[String(action.item)] ?? {
                name: String(action.item),
                glyph: '•',
                text: '',
              };
              return (
                <button
                  key={`use-${String(action.item)}`}
                  className="item-button"
                  onClick={() => onAction(action)}
                  title={item.text}
                >
                  <span className="item-glyph">{item.glyph}</span>
                  {item.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {steals.length > 0 && (
        <div className="action-block">
          <label className="action-label">Steal and use</label>
          <div className="action-grid">
            {steals.map((action) => {
              const item = ITEM_LABEL[String(action.item)] ?? {
                name: String(action.item),
                glyph: '•',
                text: '',
              };
              return (
                <button
                  key={`steal-${String(action.item)}`}
                  className="item-button"
                  onClick={() => onAction(action)}
                >
                  <span className="item-glyph">{item.glyph}</span>
                  {item.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {passes.map((action) => (
        <div key="pass" className="action-block">
          <label className="action-label">Pass</label>
          <button className="ghost" onClick={() => onAction(action)}>
            Pass
          </button>
        </div>
      ))}

      {others.length > 0 && (
        <div className="action-block">
          <label className="action-label">Choose an action</label>
          <div className="action-grid">
            {others.map((action, index) => (
              <button
                key={`${action.type}-${String(action.target ?? '')}-${String(action.role ?? '')}-${String(action.card ?? '')}-${String(action.first ?? '')}-${String(action.second ?? '')}-${index}`}
                className="action-target"
                onClick={() => onAction(action)}
              >
                {describeAction(action, view)}
              </button>
            ))}
          </div>
        </div>
      )}

      {skips.length > 0 && (
        <div className="action-block">
          {skips.map((action) => (
            <button key="skip" className="ghost" onClick={() => onAction(action)}>
              Do nothing
            </button>
          ))}
        </div>
      )}

      {actions.length > 0 && actions.every((action) => action.type === 'say') === false && (
        <p className="action-hint">
          {ROLE_GLYPH[String((view.data as Record<string, unknown>)?.yourRole ?? '')] ?? ''} Choose
          carefully — the table is watching.
        </p>
      )}
    </div>
  );
}

function describeAction(action: GameAction, view: GameView): string {
  const target = actionTargetName(action, view.seats);
  const role = typeof action.role === 'string' ? action.role : '';
  const card = typeof action.card === 'string' ? action.card : '';
  const first = typeof action.first === 'string' ? action.first : '';
  const second = typeof action.second === 'string' ? action.second : '';
  switch (action.type) {
    case 'income':
      return 'Income (+1 coin)';
    case 'foreign-aid':
      return 'Foreign aid (+2 coins)';
    case 'tax':
      return 'Tax (+3 coins)';
    case 'exchange':
      return 'Exchange cards';
    case 'coup':
      return `Coup — ${target}`;
    case 'assassinate':
      return `Assassinate — ${target}`;
    case 'steal':
      return `Steal from — ${target}`;
    case 'challenge':
      return 'Challenge the claim';
    case 'block':
      return `Block with ${role}`;
    case 'lose':
      return `Reveal ${card}`;
    case 'keep':
      return second ? `Keep ${first} and ${second}` : `Keep ${first}`;
    default:
      return target ? `${action.type} — ${target}` : action.type;
  }
}
