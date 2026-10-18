/** Set at build time from `DURIO_DEFAULT_SERVER` (vite.main.config.ts), usually "" */
declare const __DURIO_DEFAULT_SERVER__: string;

declare type DesktopConfig = {
  firstLaunch: boolean;
  customFrame: boolean;
  minimiseToTray: boolean;
  startMinimisedToTray: boolean;
  spellchecker: boolean;
  hardwareAcceleration: boolean;
  discordRpc: boolean;
  defaultServer: string;
  windowState: {
    x: number;
    y: number;
    width: number;
    height: number;
    isMaximised: boolean;
  };
};
