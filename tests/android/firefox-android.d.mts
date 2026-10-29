// Types for firefox-android.mjs, which stays plain JavaScript so the launcher runs under node.
export declare const FIREFOX_PACKAGE: string;
export declare const FIREFOX_ACTIVITY: string;
export declare const EMULATOR_PREFS: Record<string, string | number | boolean>;
export declare function readUserPrefs(text: string): Record<string, unknown>;
export declare function geckoViewConfig(options: { port: number; prefs: Record<string, unknown> }): string;
export declare function startCommand(url: string): string;
export declare class BidiRelay {
  topLevel: Set<string>;
  fromClient(text: string): { toBrowser: string[]; toClient: string[]; notes: string[]; close: boolean };
  fromBrowser(text: string): { toBrowser: string[]; toClient: string[]; notes: string[] };
}
