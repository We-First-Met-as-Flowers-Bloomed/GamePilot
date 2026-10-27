export interface TemplateUse {
  source: string;
  line: number | null;
  algorithm: string;
  roi: number[] | null;
  threshold: number | null;
}
export interface TemplateRequirement {
  name: string;
  present: boolean;
  uses: TemplateUse[];
}
export interface CaptureMapping {
  name: string;
  screenshot: string;
  template: string;
  crop: number[];
  roi: number[];
  threshold: number;
}
export interface CaptureManifest {
  schemaVersion: number;
  coordinateSpace: number[];
  mappings: CaptureMapping[];
}
export interface TemplateOptions {
  root?: string;
  manifest: unknown;
  manifestDirectory?: string;
  taskRoot?: string;
}
export interface ImageEvidence {
  path: string;
  width: number;
  height: number;
  sha256: string;
}
export interface TemplateReport {
  schemaVersion: 1;
  status: "blocked" | "ready-for-review";
  certification: "pending-real-device";
  inventory: TemplateRequirement[];
  templates: {
    name: string;
    screenshot: ImageEvidence;
    template: ImageEvidence;
    crop: number[];
    roi: number[];
    threshold: number;
    currentUses: TemplateUse[];
    requiresCodeReview: boolean;
    certification: "pending-real-device";
  }[];
  gaps: string[];
  limits: string[];
}
export function templateInventory(
  root?: string,
): Promise<TemplateRequirement[]>;
export function checkTemplateManifest(
  options: TemplateOptions,
): Promise<TemplateReport>;
export function applyTemplateManifest(
  options: TemplateOptions,
): Promise<TemplateReport & { taskRoot: string }>;
export function parseTemplateArgs(args: string[]): {
  mode: "guide" | "check" | "apply";
  root?: string;
  manifestFile?: string;
  taskRoot?: string;
};
