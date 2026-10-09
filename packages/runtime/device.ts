export type Rect = [number, number, number, number];
export interface TextHit {
  text: string;
  box: Rect;
  score: number;
}
export interface Frame {
  width: number;
  height: number;
  texts: TextHit[];
}
export interface VisualHit {
  box: Rect;
  score: number;
}
/** Game adapters depend on this port, never Electron or the native binding. */
export interface GameDevice {
  observe(signal: AbortSignal, roi?: Rect, onlyRec?: boolean): Promise<Frame>;
  click(x: number, y: number, signal: AbortSignal): Promise<void>;
  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    signal: AbortSignal,
  ): Promise<void>;
  longPress(
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void>;
  startApp(packageName: string, signal: AbortSignal): Promise<void>;
  packages(signal: AbortSignal): Promise<string[]>;
  isAppRunning(packageName: string, signal: AbortSignal): Promise<boolean>;
  matchTemplate(
    template: string,
    roi: Rect,
    threshold: number,
    signal: AbortSignal,
  ): Promise<VisualHit | null>;
  /** Scale-tolerant image matching; score is the matched feature count. */
  matchFeatures?(
    template: string,
    roi: Rect,
    signal: AbortSignal,
  ): Promise<VisualHit | null>;
  colorSlots(
    rois: Rect[],
    lower: [number, number, number],
    upper: [number, number, number],
    minPixels: number,
    signal: AbortSignal,
  ): Promise<boolean[]>;
}
