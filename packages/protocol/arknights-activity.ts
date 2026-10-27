export interface ArknightsActivityStage {
  stage: string;
  label: string;
  activity: string;
  drop: string;
  startsAt: string;
  endsAt: string;
  available: boolean;
  reason?: string;
  tip?: string;
}
export interface ArknightsActivityCatalog {
  source: string;
  fetchedAt?: string;
  stale: boolean;
  stages: ArknightsActivityStage[];
  miniGames?: ArknightsActivityStage[];
  message: string;
}
