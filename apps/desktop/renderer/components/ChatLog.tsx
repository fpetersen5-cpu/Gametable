import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatLine, SeatInfo } from '../../shared/api';
import { seatColor } from '../game-data';

export function ChatLog({
  chat,
  seats,
  previews,
}: {
  chat: ChatLine[];
  seats: SeatInfo[];
  previews?: Record<string, string>;
}) {
  const channels = useMemo(() => {
    const seen = new Set<string>();
    for (const line of chat) seen.add(line.channel);
    return [...seen];
  }, [chat]);
  const [channel, setChannel] = useState<string>('all');
  const scroller = useRef<HTMLDivElement>(null);

  const visible = channel === 'all' ? chat : chat.filter((line) => line.channel === channel);
  const drafts =
    channel === 'all'
      ? Object.entries(previews ?? {}).filter(([, text]) => text.trim().length > 0)
      : [];
  const draftLength = drafts.reduce((sum, [, text]) => sum + text.length, 0);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visible.length, draftLength, channel]);

  return (
    <div className="chat">
      {channels.length > 0 && (
        <div className="chat-tabs">
          <button
            className={channel === 'all' ? 'active' : ''}
            onClick={() => setChannel('all')}
          >
            all
          </button>
          {channels.map((name) => (
            <button
              key={name}
              className={channel === name ? 'active' : ''}
              onClick={() => setChannel(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className="chat-log" ref={scroller}>
        {visible.length === 0 && drafts.length === 0 && (
          <p className="chat-empty">No table talk yet.</p>
        )}
        {visible.map((line) => {
          const seat = seats.find((entry) => entry.id === line.seatId);
          return (
            <div key={line.id} className="chat-line">
              <span className="chat-who" style={{ color: seatColor(line.seatId) }}>
                {seat?.name ?? line.seatId}
              </span>
              {line.channel !== 'public' && <span className="chat-channel">{line.channel}</span>}
              {line.to && (
                <span className="chat-to">
                  → {seats.find((entry) => entry.id === line.to)?.name ?? line.to}
                </span>
              )}
              <span className="chat-text">{line.text}</span>
            </div>
          );
        })}
        {drafts.map(([seatId, text]) => {
          const seat = seats.find((entry) => entry.id === seatId);
          return (
            <div key={`draft-${seatId}`} className="chat-line draft">
              <span className="chat-who" style={{ color: seatColor(seatId) }}>
                {seat?.name ?? seatId}
              </span>
              <span className="chat-channel">speaking</span>
              <span className="chat-text">
                {text}
                <span className="chat-caret" aria-hidden="true">
                  ▍
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
