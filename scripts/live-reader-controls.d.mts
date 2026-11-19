import type { Locator, Page } from "@playwright/test";
export function waitForBox(locator: Locator, options?: { timeout?: number; interval?: number; description?: string }): Promise<{ x: number; y: number; width: number; height: number }>;
export function createReaderControls(options: { page: Page; room: Locator; timeout?: number; settle?: number; attempts?: number }): {
  show(control?: Locator, description?: string): Promise<boolean>;
  hide(): Promise<boolean>;
  click(control: Locator, description?: string): Promise<void>;
  turn(direction?: "next" | "previous"): Promise<void>;
  topbar: Locator;
};
export function narratedOnPage(room: Locator): Promise<boolean>;
type Point = { x: number; y: number };
type Edges = { left: number; top: number; right: number; bottom: number };
export function narratedPressPoints(rects: Edges[], bounds: Edges, options?: { minWidth?: number; minHeight?: number }): Point[];
export function narratedPressPoint(room: Locator): Promise<Point | null>;
