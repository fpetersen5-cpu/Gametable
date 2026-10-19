export type ShellType = 'live' | 'blank';
export type Player = 0 | 1;

export type ItemType =
  | 'cigarette'
  | 'beer'
  | 'magnifier'
  | 'handsaw'
  | 'handcuffs'
  | 'pills'
  | 'burner'
  | 'inverter'
  | 'adrenaline';

export const ITEMS: Record<ItemType, { name: string; description: string }> = {
  cigarette: { name: 'Cigarette', description: 'Restore 1 health, up to the maximum.' },
  beer: { name: 'Beer', description: 'Eject the current shell; everyone sees what it was.' },
  magnifier: { name: 'Magnifying glass', description: 'Privately look at the current shell.' },
  handsaw: { name: 'Handsaw', description: 'Your next shot deals 2 damage instead of 1.' },
  handcuffs: { name: 'Handcuffs', description: 'Your opponent skips their next turn.' },
  pills: { name: 'Pills', description: '50% chance: restore 2 health, or lose 1.' },
  burner: { name: 'Burner phone', description: 'Privately learn the type of a future shell.' },
  inverter: { name: 'Inverter', description: 'Flip the current shell from live to blank or back.' },
  adrenaline: {
    name: 'Adrenaline',
    description: "Steal one of your opponent's items and use it at once.",
  },
};

export const ITEM_ORDER: ItemType[] = [
  'cigarette',
  'beer',
  'magnifier',
  'handsaw',
  'handcuffs',
  'pills',
  'burner',
  'inverter',
  'adrenaline',
];
