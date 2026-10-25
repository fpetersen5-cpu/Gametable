import type { ReactNode } from 'react';

export type IconName =
  | 'arena'
  | 'arrow'
  | 'brand'
  | 'cards'
  | 'check'
  | 'leaderboard'
  | 'match'
  | 'plus'
  | 'refresh'
  | 'replay'
  | 'settings'
  | 'shield'
  | 'table'
  | 'users';

interface Props {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 18, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

const paths: Record<IconName, ReactNode> = {
  arena: (
    <>
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M7 6H4v2a4 4 0 0 0 4 4M17 6h3v2a4 4 0 0 1-4 4" />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  brand: (
    <>
      <path d="m12 3 7 4v10l-7 4-7-4V7l7-4Z" />
      <path d="m8.5 9 3.5-2 3.5 2-3.5 2-3.5-2ZM8.5 13l3.5 2 3.5-2" />
    </>
  ),
  cards: (
    <>
      <rect x="7" y="3" width="12" height="17" rx="2" />
      <path d="m5 7-1.7.4A2 2 0 0 0 2 9.3l3 10A2 2 0 0 0 7.5 21l5.5-1M10 8h6M10 12h4" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  leaderboard: (
    <>
      <path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7M2 20h20" />
    </>
  ),
  match: (
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="m7 7 10 10M17 7 7 17" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 8a7 7 0 0 1 11.8-1L20 12M4 12l2.1 5a7 7 0 0 0 11.8-1" />
    </>
  ),
  replay: (
    <>
      <path d="M4 8V3m0 5h5M4.8 8a8 8 0 1 1-.6 6" />
      <path d="m10 9 5 3-5 3V9Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  table: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 4 4.9V20" />
    </>
  ),
};
