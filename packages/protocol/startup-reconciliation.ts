/** Host-owned facts align only one old StartUp hazard; they never rewrite its outcome. */
export interface StartupReconciliationBinding {
  resource: string;
  laneId: string;
  instance: number;
  profileId: string;
  clientType: "Official" | "Bilibili";
  identityHash: string;
  profileHash: string;
}
export interface StartupReconciliationCandidate {
  version: 1;
  originalRequestId: string;
  originalFingerprint: string;
  originalRunId: string;
  skillId: "login";
  evidenceHash: string;
  gameDay: string;
  binding: StartupReconciliationBinding;
}
export interface StartupExecutorExitEvidence {
  verified: true;
  requestId: string;
  resource: string;
  observedAt: string;
  evidenceReference: string;
}
export interface StartupReconciliationFact {
  version: 1;
  id: string;
  candidate: StartupReconciliationCandidate;
  executorExit: StartupExecutorExitEvidence;
  freshLogin: {
    requestId: string;
    requestFingerprint: string;
    runId: string;
    evidenceHash: string;
    observedAt: string;
    evidenceReference: string;
  };
  reconciledAt: string;
}
export function validStartupReconciliationFact(
  input: unknown,
): input is StartupReconciliationFact {
  const value = object(input, [
    "version",
    "id",
    "candidate",
    "executorExit",
    "freshLogin",
    "reconciledAt",
  ]);
  if (
    !value ||
    value.version !== 1 ||
    !identifier(value.id) ||
    !validStartupReconciliationCandidate(value.candidate) ||
    !validStartupExecutorExitEvidence(value.executorExit) ||
    !date(value.reconciledAt)
  )
    return false;
  if (
    value.executorExit.requestId !== value.candidate.originalRequestId ||
    value.executorExit.resource !== value.candidate.binding.resource
  )
    return false;
  const login = object(value.freshLogin, [
    "requestId",
    "requestFingerprint",
    "runId",
    "evidenceHash",
    "observedAt",
    "evidenceReference",
  ]);
  if (
    !login ||
    !identifier(login.requestId) ||
    !hash(login.requestFingerprint) ||
    !identifier(login.runId) ||
    !hash(login.evidenceHash) ||
    !date(login.observedAt) ||
    !identifier(login.evidenceReference, 240) ||
    login.requestId === value.candidate.originalRequestId ||
    login.runId === value.candidate.originalRunId
  )
    return false;
  const observed = Date.parse(login.observedAt),
    at = Date.parse(value.reconciledAt);
  return (
    observed >= Date.parse(value.executorExit.observedAt) &&
    at >= observed &&
    at - observed <= 15_000
  );
}

function object(
  input: unknown,
  keys: string[],
): Record<string, unknown> | undefined {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    return;
  return input as Record<string, unknown>;
}
const identifier = (input: unknown, maximum = 160): input is string =>
  typeof input === "string" &&
  input.length > 0 &&
  input.length <= maximum &&
  /^[A-Za-z0-9:._-]+$/.test(input);
const hash = (input: unknown): input is string =>
  typeof input === "string" && /^[a-f0-9]{64}$/.test(input);
const date = (input: unknown): input is string =>
  typeof input === "string" &&
  input.length <= 50 &&
  Number.isFinite(Date.parse(input));

export function validStartupExecutorExitEvidence(
  input: unknown,
): input is StartupExecutorExitEvidence {
  const value = object(input, [
    "verified",
    "requestId",
    "resource",
    "observedAt",
    "evidenceReference",
  ]);
  return (
    !!value &&
    value.verified === true &&
    identifier(value.requestId) &&
    resource(value.resource) &&
    date(value.observedAt) &&
    identifier(value.evidenceReference, 240)
  );
}

const resource = (input: unknown): input is string =>
  typeof input === "string" &&
  input.length <= 1024 &&
  /^mumu:(?:[a-z]:[\\/]|[\\/]{2})[^\x00-\x1f]+#\d{1,3}$/i.test(input);

export function validStartupReconciliationCandidate(
  input: unknown,
): input is StartupReconciliationCandidate {
  const value = object(input, [
    "version",
    "originalRequestId",
    "originalFingerprint",
    "originalRunId",
    "skillId",
    "evidenceHash",
    "gameDay",
    "binding",
  ]);
  if (
    !value ||
    value.version !== 1 ||
    !identifier(value.originalRequestId) ||
    !hash(value.originalFingerprint) ||
    !identifier(value.originalRunId) ||
    value.skillId !== "login" ||
    !hash(value.evidenceHash) ||
    typeof value.gameDay !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.gameDay) ||
    !date(`${value.gameDay}T00:00:00.000Z`) ||
    new Date(`${value.gameDay}T00:00:00.000Z`).toISOString().slice(0, 10) !==
      value.gameDay
  )
    return false;
  const binding = object(value.binding, [
    "resource",
    "laneId",
    "instance",
    "profileId",
    "clientType",
    "identityHash",
    "profileHash",
  ]);
  return (
    !!binding &&
    resource(binding.resource) &&
    identifier(binding.laneId) &&
    Number.isInteger(binding.instance) &&
    Number(binding.instance) >= 0 &&
    Number(binding.instance) <= 999 &&
    identifier(binding.profileId) &&
    ["Official", "Bilibili"].includes(String(binding.clientType)) &&
    hash(binding.identityHash) &&
    hash(binding.profileHash)
  );
}
