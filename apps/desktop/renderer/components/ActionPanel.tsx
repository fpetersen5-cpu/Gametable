import { useEffect, useState } from 'react';
import type { GameAction, GameView } from '../../shared/api';
import { ITEM_LABEL, ROLE_GLYPH, actionTargetName } from '../game-data';

interface Props {
  view: GameView;
  awaiting: boolean;
  onAction: (action: GameAction) => void;
}

export function ActionPanel({ view, awaiting, onAction }: Props) {
  const [text, setText] = useState('');
  const actions = view.legalActions;
  const actor = view.phase.actors[0];
  const actorName = view.seats.find((seat) => seat.id === actor)?.name;

  useEffect(() => {
    setText('');
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

  const say = actions.find((action) => action.type === 'say');
  const shoots = actions.filter((action) => action.type === 'shoot');
  const items = actions.filter((action) => action.type === 'use');
  const steals = actions.filter((action) => action.type === 'steal');
  const skips = actions.filter((action) => action.type === 'skip');
  const targetActions = actions.filter((action) =>
    ['vote', 'kill', 'investigate', 'save', 'probe'].includes(action.type),
  );

  const submitText = () => {
    const value = text.trim();
    if (!value) return;
    onAction({ type: 'say', text: value.slice(0, 600) });
    setText('');
  };

  return (
    <div className="action-panel">
      <h3>Your move</h3>

      {say && (
        <div className="action-block">
          <label className="action-label">Say something</label>
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
          <button className="primary" disabled={!text.trim()} onClick={submitText}>
            Speak
          </button>
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
                onClick={() => onAction(action)}
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
