export interface ContinuationSelection {
  gameId: string;
  skillIds: string[];
}
export interface ContinuationStep {
  gameId: string;
  skillId: string;
  status: "retained" | "retry" | "pending" | "blocked" | "excluded";
  message: string;
}
export interface ContinuationPreview {
  parentId: string;
  fingerprint: string;
  laneName: string;
  canContinue: boolean;
  reasons: string[];
  steps: ContinuationStep[];
  defaults: ContinuationSelection[];
  successorId?: string;
  needsAcknowledgement: boolean;
}
export interface ContinuationInput {
  parentId: string;
  fingerprint: string;
  selections: ContinuationSelection[];
  acknowledgePartial: boolean;
}
export interface ContinuationLink {
  parentId: string;
  parentFingerprint: string;
  retained: ContinuationSelection[];
  excluded: ContinuationSelection[];
  acknowledgedPartial: boolean;
}
