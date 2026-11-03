// Whether a recorded run can answer a stated question, decided before anything is imported. A
// question lists the kinds of evidence it needs and where they must sit together: in the run, in
// every attempt, or all in one attempt, at least so many times. A layout's survey says, for each
// attempt and each kind, whether its files hold that kind (present), hold nothing of it (missing), or
// hold something that is not it (incompatible), each with the survey's reason. The assessment only
// combines the two: it reads no file and knows no layout, so the same rule judges every run.
//
// Missing and incompatible evidence stays as the survey found it. Nothing here fills a gap, turns a
// derived value into a recording, or counts a kind the survey did not state as present. A kind a
// survey says nothing of reads missing, with that as its reason.
//
// A part of a question that no evidence kind in the core can answer is named by a kind no survey
// states, so it reads missing, and no run supports importing for a question with that part unjudged.
//
// The verdict supports import only when every requirement is met and the reading behind the survey
// does not refuse the run. It never says the question is answered, only that the evidence it needs
// is there to read. An assessment carries the digest of the run its survey read; importCase makes
// its own from one reading and takes none from a caller.

/** The kinds of evidence a question can need. A survey states each for each attempt, or for the run. */
export const EVIDENCE_KINDS = [
  "attempt-identity",
  "recorder-identity",
  "main-document",
  "script-inventory",
  "script-execution",
  "call-frames",
  "listener-registrations",
  "observer-outcome",
  "scanner-reads",
  "requests",
  "window",
  "registrable-domain-rule"
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** What each kind is, in words a question and a survey are both held to. */
export const KIND_MEANINGS: Readonly<Record<EvidenceKind, string>> = {
  "attempt-identity": "which attempt this is and when it began, as the recording states it",
  "recorder-identity": "the release and commit of the recorder whose outputs are read",
  "main-document": "the address or status of the main document the attempt loaded",
  "script-inventory": "the attempt's own list of scripts, each with a digest, covering what the question asks about",
  "script-execution": "ranges of script the attempt's recorder reported executed, in a stated window",
  "call-frames": "call stacks whose frames each carry a URL and a position",
  "listener-registrations": "each event listener registration the page made, as recorded",
  "observer-outcome": "the scanner observer's own outcome for each item the question asks about",
  "scanner-reads": "the scanner's own detection reads",
  requests: "requests with their recorded callsites",
  window: "a stated window, with the clock it is on",
  "registrable-domain-rule": "a registrable-domain rule, pinned to a version; the workspace core holds none, so no survey states it and it reads missing"
};

export type KindStatus = Readonly<{ status: "present" | "missing" | "incompatible"; reason: string }>;

export type Survey = Readonly<{
  /** The digest of the run the survey read: see runDigestOf in imported-ids.ts. */
  runDigest: string;
  /** Why the reading behind the survey (the adapter's, or the trial layout's) refuses the run, or null. A survey with one supports no question. */
  refusal: string | null;
  run: Readonly<Partial<Record<EvidenceKind, KindStatus>>>;
  attempts: readonly Readonly<{ attempt: string; kinds: Readonly<Partial<Record<EvidenceKind, KindStatus>>> }>[];
}>;

export type Requirement =
  | Readonly<{ kinds: readonly EvidenceKind[]; within: "the-run" }>
  | Readonly<{ kinds: readonly EvidenceKind[]; within: "every-attempt" }>
  | Readonly<{ kinds: readonly EvidenceKind[]; within: "one-attempt"; atLeast: number }>;

export type Question = Readonly<{ id: string; text: string; requirements: readonly Requirement[] }>;

export type KindFinding = Readonly<{
  kind: EvidenceKind;
  present: readonly string[];
  missing: readonly Readonly<{ attempt: string; reason: string }>[];
  incompatible: readonly Readonly<{ attempt: string; reason: string }>[];
}>;

export type RequirementFinding = Readonly<{
  requirement: Requirement;
  met: boolean;
  /** The attempts holding every kind it lists, or the run itself as "run". */
  holding: readonly string[];
  kinds: readonly KindFinding[];
}>;

export type Assessment = Readonly<{
  question: string;
  /** The run this assessment judged, by the digest its survey read. */
  runDigest: string;
  verdict: "supports-import" | "does-not-support-import";
  requirements: readonly RequirementFinding[];
  /** One line per requirement not met, naming each kind that kept it unmet and how many attempts said why. */
  reasons: readonly string[];
}>;

export type AssessmentResult = Readonly<{ ok: true; assessment: Assessment }> | Readonly<{ ok: false; refusal: "question-malformed" | "survey-malformed"; at: string }>;

const RUN = "run";

function isKind(value: unknown): value is EvidenceKind {
  return (EVIDENCE_KINDS as readonly unknown[]).includes(value);
}

function questionProblem(question: Question): string | null {
  if (typeof question !== "object" || question === null || typeof question.id !== "string" || question.id === "" || typeof question.text !== "string") return "question";
  if (!Array.isArray(question.requirements) || question.requirements.length === 0) return "requirements";
  for (const [index, requirement] of question.requirements.entries()) {
    const at = `requirements[${index}]`;
    if (typeof requirement !== "object" || requirement === null || !Array.isArray(requirement.kinds) || requirement.kinds.length === 0 || !requirement.kinds.every(isKind)) return `${at}.kinds`;
    if (new Set(requirement.kinds).size !== requirement.kinds.length) return `${at}.kinds`;
    if (requirement.within === "one-attempt") {
      if (!Number.isSafeInteger(requirement.atLeast) || requirement.atLeast < 1) return `${at}.atLeast`;
    } else if (requirement.within !== "the-run" && requirement.within !== "every-attempt") return `${at}.within`;
  }
  return null;
}

function isStatus(value: unknown): value is KindStatus {
  if (typeof value !== "object" || value === null) return false;
  const { status, reason } = value as Record<string, unknown>;
  return (status === "present" || status === "missing" || status === "incompatible") && typeof reason === "string";
}

function surveyProblem(survey: Survey): string | null {
  if (typeof survey !== "object" || survey === null || typeof survey.run !== "object" || survey.run === null || Array.isArray(survey.run) || !Array.isArray(survey.attempts)) return "survey";
  if (typeof survey.runDigest !== "string" || !/^[0-9a-f]{64}$/.test(survey.runDigest)) return "runDigest";
  if (survey.refusal !== null && typeof survey.refusal !== "string") return "refusal";
  for (const [kind, value] of Object.entries(survey.run)) {
    if (!isKind(kind) || !isStatus(value)) return "run";
  }
  const seen = new Set<string>();
  for (const [index, entry] of survey.attempts.entries()) {
    if (typeof entry !== "object" || entry === null || typeof entry.attempt !== "string" || entry.attempt === RUN || seen.has(entry.attempt) || typeof entry.kinds !== "object" || entry.kinds === null) return `attempts[${index}]`;
    seen.add(entry.attempt);
    for (const [kind, value] of Object.entries(entry.kinds)) {
      if (!isKind(kind) || !isStatus(value)) return `attempts[${index}].kinds`;
    }
  }
  return null;
}

const SAID_NOTHING: KindStatus = { status: "missing", reason: "the survey says nothing of it" };

/** Own keys only, so no name every object answers to is read as a kind. */
function statusIn(kinds: Readonly<Partial<Record<EvidenceKind, KindStatus>>>, kind: EvidenceKind): KindStatus {
  return Object.prototype.hasOwnProperty.call(kinds, kind) ? (kinds[kind] as KindStatus) : SAID_NOTHING;
}

function findingFor(kind: EvidenceKind, entries: readonly Readonly<{ attempt: string; status: KindStatus }>[]): KindFinding {
  return {
    kind,
    present: entries.filter(({ status }) => status.status === "present").map(({ attempt }) => attempt),
    missing: entries.filter(({ status }) => status.status === "missing").map(({ attempt, status }) => ({ attempt, reason: status.reason })),
    incompatible: entries.filter(({ status }) => status.status === "incompatible").map(({ attempt, status }) => ({ attempt, reason: status.reason }))
  };
}

function judged(requirement: Requirement, survey: Survey): RequirementFinding {
  if (requirement.within === "the-run") {
    const kinds = requirement.kinds.map((kind) => findingFor(kind, [{ attempt: RUN, status: statusIn(survey.run, kind) }]));
    const met = kinds.every(({ present }) => present.length === 1);
    return { requirement, met, holding: met ? [RUN] : [], kinds };
  }
  const kinds = requirement.kinds.map((kind) => findingFor(kind, survey.attempts.map(({ attempt, kinds: held }) => ({ attempt, status: statusIn(held, kind) }))));
  const holding = survey.attempts.filter(({ kinds: held }) => requirement.kinds.every((kind) => statusIn(held, kind).status === "present")).map(({ attempt }) => attempt);
  const met = requirement.within === "every-attempt" ? survey.attempts.length > 0 && holding.length === survey.attempts.length : holding.length >= requirement.atLeast;
  return { requirement, met, holding, kinds };
}

function placeOf(requirement: Requirement): string {
  if (requirement.within === "the-run") return "in the run";
  if (requirement.within === "every-attempt") return "in every attempt";
  return `together in at least ${requirement.atLeast} attempt${requirement.atLeast === 1 ? "" : "s"}`;
}

function reasonFor(finding: RequirementFinding): string {
  const held = finding.requirement.within === "the-run" ? "" : `; ${finding.holding.length} attempt${finding.holding.length === 1 ? "" : "s"} hold all of them`;
  const short = finding.kinds
    .filter(({ missing, incompatible }) => missing.length + incompatible.length > 0)
    .map(({ kind, missing, incompatible }) => {
      const parts = [missing.length > 0 ? `missing in ${missing.length}` : "", incompatible.length > 0 ? `incompatible in ${incompatible.length}` : ""].filter((part) => part !== "");
      return `${kind} (${parts.join(", ")})`;
    });
  return `${finding.requirement.kinds.join(", ")} needed ${placeOf(finding.requirement)}${held}; short: ${short.length > 0 ? short.join("; ") : "none, but too few attempts hold them together"}`;
}

/** The question's requirements, held to the survey. */
export function assessSufficiency(question: Question, survey: Survey): AssessmentResult {
  const badQuestion = questionProblem(question);
  if (badQuestion !== null) return { ok: false, refusal: "question-malformed", at: badQuestion };
  const badSurvey = surveyProblem(survey);
  if (badSurvey !== null) return { ok: false, refusal: "survey-malformed", at: badSurvey };
  const requirements = question.requirements.map((requirement) => judged(requirement, survey));
  const unmet = requirements.filter(({ met }) => !met);
  const reasons = [...(survey.refusal === null ? [] : [`the survey's reading refuses this run: ${survey.refusal}`]), ...unmet.map(reasonFor)];
  return { ok: true, assessment: { question: question.id, runDigest: survey.runDigest, verdict: reasons.length === 0 ? "supports-import" : "does-not-support-import", requirements, reasons } };
}
