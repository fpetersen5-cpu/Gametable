import type { DesktopApi } from '../shared/api.js';

declare global {
  interface Window {
    gametable: DesktopApi;
  }
}

export {};
