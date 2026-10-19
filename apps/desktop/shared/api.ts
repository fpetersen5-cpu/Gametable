import type { KeyInfo, ModelInfo } from '@gametable/agent';

export type { KeyInfo, ModelInfo };

/** The renderer's entire surface. No key, no prompts, no game state. */
export interface DesktopApi {
  status(): Promise<AppStatus>;
  setKey(key: string): Promise<KeyResult>;
  clearKey(): Promise<void>;
  listModels(refresh?: boolean): Promise<ModelCatalogResult>;
  loadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
}

export interface AppStatus {
  version: string;
  hasKey: boolean;
  keyInfo: KeyInfo | null;
  storage: 'portal' | 'file';
}

export interface KeyResult {
  ok: boolean;
  error?: string;
  keyInfo?: KeyInfo;
}

export interface ModelCatalogResult {
  models: ModelInfo[];
  fetchedAt: number;
  fromCache: boolean;
}

export interface SeatConfig {
  modelId: string;
  persona?: string;
  temperature?: number;
}

export interface AppConfig {
  humanName: string;
  seats: SeatConfig[];
  /** Hard ceiling for a single match, in USD. */
  budgetUsd: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  humanName: 'You',
  seats: [],
  budgetUsd: 2,
};
