export interface DistributionArtifact {
  path: string;
  sha256: string;
}
export interface DistributionComponent {
  id: string;
  version: string;
  license: string;
  files: DistributionArtifact[];
  notices: DistributionArtifact[];
  source?: DistributionArtifact & {
    upstream: string;
    buildInstructions: string;
  };
}
export interface DistributionManifest {
  version: number;
  components: DistributionComponent[];
}
export interface DistributionAudit {
  version: number;
  status: "blocked" | "ready-for-review";
  binaries: DistributionArtifact[];
  components: {
    id: string;
    version: string;
    license: string;
    sourceIncluded: boolean;
  }[];
  gaps: string[];
  note: string;
}
export function auditDistribution(
  directory: string,
  manifest?: DistributionManifest,
): Promise<DistributionAudit>;
