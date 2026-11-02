// The viewer's pages, rendered whole in the Worker as HTML with no script.
//
// What a page says of evidence is read through W2's functions: a row's reading through readRow,
// with its limits through limitsOfReading, the one rule a count also uses, rendered by one function
// on every page; one attempt's evidence through evidenceForAttempt; counts through aggregate, with
// their denominators and what they are presented as; a source identity through sourceIdentityOf;
// what a waiting slot's visit would rest on through visitBasisOf. The rest is the case's state as
// the log folded it, named as the model names it. A recorded count is never printed beside its
// reading, so a 0 that reads unknown cannot be read as a 0, and the summary tier, whose ranges
// keep a count of 0 as the capture gave it, is not read here at all.
//
// A fact's link carries the limits its row was read under when the fact was recorded. A page
// shows that snapshot as a snapshot, beside the row's reading now, and never one for the other.
// Counts across attempts say so. W2's record holds no execution join, so no page shows one.
//
// Every value reaches markup through viewer-text.ts's html tag, so it is text whatever it holds.
// Every link is to one of these pages, built from ids the log's decoder already held to a shape,
// and nothing a capture held is ever a link, an image or anything else a browser would fetch.
//
// Every page states what the workspace cannot answer, and that limits specific to REA arrive
// with the adapter batch.

import { aggregate, evidenceForAttempt, limitsOfReading, type AggregateGroup, type Measure } from "./aggregates";
import { configurationKey } from "./case-events";
import { continuationOf, denominatorOf, retentionOf, visitBasisOf, type AttemptState, type MachineState } from "./case-machine";
import type { CaseView, EvidencePage } from "./case-service";
import { aggregateRowsOfCase, type CaseState } from "./case-store";
import { readRow, sourceIdentityOf, type EvidenceRecord, type EvidenceRow, type Fact, type Interpretation, type RowReading, type RowWindow } from "./evidence-model";
import { attribute, hiddenField, html, linkTo, Markup, MAX_INDENT, pathOf } from "./viewer-text";
import { VIEWER_STYLE } from "./workspace-response";

/** The four things no case here can answer, stated on every page. */
export const CANNOT_ANSWER: readonly string[] = [
  "Execution in child frames and in workers.",
  "Pages that lose REA coverage to the negative-column defect.",
  "Anything before arming, behavior while signed in, and the contents of payloads.",
  "Authorship, purpose, and whether a backend received anything."
];

export const ADAPTER_NOTE = "Limits specific to REA arrive with the adapter batch (W4). None are shown here yet.";

/** What a page says above its content after a write: nothing was written, and why. */
export type Notice = Readonly<{ kind: "conflict" }> | Readonly<{ kind: "refused"; refusal: string; at: string | null }>;

const REFUSAL_SHAPE = /^[a-z][a-z0-9-]{0,63}$/;
const AT_SHAPE = /^[A-Za-z0-9_.[\] -]{1,96}$/;

/** A refusal's name, if it has the shape every refusal has. It never holds a value. */
function refusalName(refusal: string): string {
  return REFUSAL_SHAPE.test(refusal) ? refusal : "unrecognized";
}

/** Where a refusal points: a field, a kind or an address. Anything of another shape is not shown. */
function refusalPlace(at: string | null): Markup {
  if (at === null) return html``;
  return AT_SHAPE.test(at) ? html` at <code>${at}</code>` : html` at a place not shown`;
}

function disclosure(): Markup {
  return html`<aside><h2>What this workspace cannot answer</h2><ul>${CANNOT_ANSWER.map((line) => html`<li>${line}</li>`)}</ul><p>${ADAPTER_NOTE}</p></aside>`;
}

function documentOf(title: string, caseId: string | null, body: Markup, notice: Markup = html``): string {
  const nav = caseId === null ? html`` : html`<nav>${linkTo(["cases", caseId], "Case")}${linkTo(["cases", caseId, "aggregates"], "Counts across attempts")}</nav>`;
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${new Markup(VIEWER_STYLE)}</style></head><body><header><p class="muted">Private investigation workspace. Owner only. Text a capture held or the owner wrote shows in the order it is stored, so right-to-left text reads in stored order. Every code point but a plain space or tab that could show as nothing, private-use and unassigned ones among them, shows as a token, such as U+202E. A space or tab shows as itself only alone inside a line, or in indentation of spaces alone or tabs alone, at most ${MAX_INDENT}, with text after it on its line; any other run of them shows as a count, such as 2 spaces 1 tab.</p>${nav}</header>${notice}<main>${body}</main>${disclosure()}</body></html>`.source;
}

function noticeOf(notice: Notice | null): Markup {
  if (notice === null) return html``;
  if (notice.kind === "conflict") {
    return html`<div class="banner" role="alert"><strong>Nothing was written.</strong> The case changed after you viewed it, so your form named a head that is no longer the head. This is the case as it stands now. Read it again before you write.</div>`;
  }
  return html`<div class="banner" role="alert"><strong>Nothing was written.</strong> The case refused it: <code>${refusalName(notice.refusal)}</code>${refusalPlace(notice.at)}. This is the case as it stands now.</div>`;
}

function limitList(limits: readonly string[]): Markup {
  if (limits.length === 0) return html`<span class="muted">no limits</span>`;
  return html`<ul class="limits">${limits.map((limit) => html`<li><code>${limit}</code></li>`)}</ul>`;
}

/**
 * A row's reading in words, the one rendering every page uses. Unknown never carries a count,
 * recorded says there is nothing to read, and the limits are limitsOfReading's, so a row read
 * unknown for its own state names that state as its limit, as a count across attempts does.
 */
export function readingMarkup(reading: RowReading): Markup {
  const limits = html`Limits: ${limitList(limitsOfReading(reading))}`;
  switch (reading.reading) {
    case "observed":
      return html`<strong>observed</strong>: ${reading.count} counted at ${reading.granularity} granularity, window ended <code>${reading.windowEnd}</code>, ${reading.complete ? "complete" : "not complete"}. ${limits}`;
    case "zero_in_window":
      return html`<strong>zero in this window</strong> at ${reading.granularity} granularity, window ended <code>${reading.windowEnd}</code>, ${reading.complete ? "complete" : "not complete"}. It speaks for this window only. ${limits}`;
    case "unknown":
      return html`<strong>unknown</strong>, for <code>${reading.reason}</code>. ${limits}`;
    case "recorded":
      return html`<strong>recorded</strong>, with no observation to read.`;
  }
}

function windowMarkup(window: RowWindow): Markup {
  if (window.clock === null) return html`no clock: <code>${window.note}</code>`;
  return html`clock <code>${window.clock}</code>, ${window.startMs} ms to ${window.endMs} ms`;
}

function configurationName(state: CaseState, key: string | null): string {
  if (key === null) return "none yet";
  const index = state.configurations.findIndex((identity) => configurationKey(identity) === key);
  return index === -1 ? "not among this case's configurations" : `configuration ${index + 1}`;
}

function attemptOf(machine: MachineState, slot: string): AttemptState | null {
  return machine.attempts.find((attempt) => attempt.slot === slot) ?? null;
}

/**
 * What a slot's visit rested on: the basis recorded when it began, or, for a slot still waiting
 * in an open case, what it would rest on as things stand. The model sets the exploratory mark when
 * an exception is recorded, not when a visit uses one, so the overview and this column say each
 * thing apart and cannot contradict each other.
 */
function basisMarkup(state: CaseState, attempt: AttemptState): Markup {
  const visit = state.record.visitBases.find(({ slot }) => slot === attempt.slot);
  if (visit !== undefined) return html`<code>${visit.basis}</code>`;
  if (attempt.phase !== "planned" || state.machine.closedBy !== null) return html`no visit`;
  // What a visit would rest on, not whether one may begin: the machine decides that, and this does not restate it.
  const next = visitBasisOf(state.machine, attempt.slot);
  return next === null ? html`no visit yet; if a visit began here, nothing would cover it` : html`no visit yet; if a visit began here, it would rest on <code>${next}</code>`;
}

function rowPath(caseId: string, row: Pick<EvidenceRow, "slot" | "id">): readonly string[] {
  return ["cases", caseId, "attempts", row.slot, "rows", row.id];
}

function sourceMarkup(caseId: string, record: EvidenceRecord, slot: AttemptState["slot"]): Markup {
  const source = sourceIdentityOf(record, slot);
  if (source.state === "not_recorded") return html`not recorded`;
  if (source.state === "recorded") return html`recorded: commit <code>${source.commit}</code>, identity <code>${source.identity}</code>`;
  return html`reconstructed: base commit <code>${source.baseCommit}</code>, patch ${linkToEvidence(caseId, source.patchDigest)}, identity <code>${source.identity}</code>`;
}

function linkToEvidence(caseId: string, digest: string): Markup {
  return linkTo(["cases", caseId, "evidence", digest], html`<code>${digest}</code>`);
}

function attemptHeader(caseId: string, state: CaseState, attempt: AttemptState): Markup {
  const { record } = state;
  const reason = record.acquisitionReasons.find(({ slot }) => slot === attempt.slot);
  const instruments = record.instruments.filter(({ slot }) => slot === attempt.slot);
  return html`<table>
<tr><th>Slot</th><td>${linkTo(["cases", caseId, "attempts", attempt.slot], attempt.slot)} (${attempt.arm})</td></tr>
<tr><th>Attempt id</th><td><code>${attempt.attemptId}</code></td></tr>
<tr><th>Phase</th><td><code>${attempt.phase}</code></td></tr>
<tr><th>Cleanup</th><td>${attempt.cleanup === null ? "nothing to clean up yet" : html`<code>${attempt.cleanup}</code>`}</td></tr>
<tr><th>Configuration</th><td>${configurationName(state, attempt.configuration)}</td></tr>
<tr><th>Visit rested on</th><td>${basisMarkup(state, attempt)}</td></tr>
<tr><th>Why it ended so</th><td>${reason === undefined ? html`<span class="muted">nothing reported</span>` : html`<code>${reason.reason}</code>`}</td></tr>
<tr><th>Instruments</th><td>${instruments.length === 0 ? html`<span class="muted">none reported their coverage</span>` : html`<ul class="limits">${instruments.map((instrument) => html`<li><code>${instrument.instrument}</code>: ${instrument.completeness}${instrument.reason === null ? "" : html`, <code>${instrument.reason}</code>`}</li>`)}</ul>`}</td></tr>
<tr><th>Source identity</th><td>${sourceMarkup(caseId, record, attempt.slot)}</td></tr>
</table>`;
}

/** Items with a comma between each, and none after the last. */
function joined(items: readonly Markup[]): Markup {
  return html`${items.map((item, index) => (index === 0 ? item : html`, ${item}`))}`;
}

function textBlock(text: string): Markup {
  return html`<div class="text">${text}</div>`;
}

function postForm(path: readonly string[], head: string, button: string, fields: Markup): Markup {
  return html`<form method="post" action="${attribute(pathOf(path))}">${hiddenField("head", head)}${fields}<button type="submit">${button}</button></form>`;
}

function textField(name: string, label: string, required = true): Markup {
  return required ? html`<label>${label}<input type="text" name="${attribute(name)}" required></label>` : html`<label>${label}<input type="text" name="${attribute(name)}"></label>`;
}

function areaField(name: string, label: string, required = true): Markup {
  return required ? html`<label>${label}<textarea name="${attribute(name)}" required></textarea></label>` : html`<label>${label}<textarea name="${attribute(name)}"></textarea></label>`;
}

function unknownFields(required: boolean): Markup {
  return html`<fieldset><legend>${required ? "The unknown this leaves" : "An unknown this leaves, if any"}</legend>${textField("unknown-id", "Unknown id", required)}${areaField("unknown-question", "Question", required)}${areaField("unknown-reason", "Why it is unknown", required)}${areaField("unknown-detail", "Detail", false)}${areaField("unknown-would-resolve", "What would resolve it", false)}</fieldset>`;
}

function factOf(record: EvidenceRecord, id: string): Fact | null {
  return record.facts.find((fact) => fact.id === id) ?? null;
}

function interpretationSection(caseId: string, view: CaseView, state: CaseState, interpretation: Interpretation): Markup {
  const { record } = state;
  const cited = interpretation.cites.map((cite) => ({ cite, fact: factOf(record, cite.fact) }));
  const flagged = interpretation.review === "needs_review";
  let review = html``;
  if (flagged) {
    const resting = cited.filter(({ fact }) => fact === null || fact.status !== "current");
    review =
      resting.length > 0
        ? html`<p class="flag">It rests on a retracted fact, so it cannot be reaffirmed. Write a new interpretation instead.</p>`
        : postForm(
            ["cases", caseId, "interpretations", interpretation.id, "reaffirm"],
            view.head,
            "Reaffirm against these versions",
            html`<p>Reaffirming binds this interpretation to the versions below, as they stand at the head you are viewing. It publishes nothing and approves nothing.</p><ul>${cited.map(({ cite, fact }) => html`<li>${hiddenField("cite", `${cite.fact}:${(fact as Fact).version}`)}${linkTo(["cases", caseId, "facts", cite.fact], cite.fact)}: version ${(fact as Fact).version} now, read against version ${cite.version}</li>`)}</ul>`
          );
  }
  return html`<section><h3>${interpretation.id}</h3>${textBlock(interpretation.statement)}
<p>${flagged ? html`<span class="flag">Needs review.</span>` : html`Current.`} Reaffirmed ${interpretation.reaffirmations} times.</p>
<p>Cites: ${joined(cited.map(({ cite, fact }) => html`${linkTo(["cases", caseId, "facts", cite.fact], cite.fact)} at version ${cite.version}${fact === null ? "" : fact.status === "current" ? html` (now version ${fact.version})` : html` (now retracted)`}`))}</p>
${interpretation.flags.length === 0 ? html`` : html`<ul>${interpretation.flags.map((flag) => html`<li class="flag">${flag.fact} was ${flag.change} from version ${flag.fromVersion}, at entry ${flag.atSeq}.</li>`)}</ul>`}
${review}</section>`;
}

/** One case, whole: where its attempts stand, and every claim with its evidence. */
export function casePage(view: CaseView, notice: Notice | null = null): string {
  const { caseId, state } = view;
  if (state === null) return documentOf(`Case ${caseId}`, caseId, html`<h1>Case ${caseId}</h1><p>This case has a log and no plan yet, so there is nothing to read.</p>`, noticeOf(notice));
  const { machine, record } = state;
  const counts = denominatorOf(machine);
  const continuation = continuationOf(machine);
  const exceptionVisits = record.visitBases.filter(({ basis }) => basis === "exception").map(({ slot }) => slot);
  const currentFacts = record.facts.filter(({ status }) => status === "current");

  const overview = html`<table>
<tr><th>Head</th><td><code>${view.head}</code>, after ${view.seq} entries</td></tr>
<tr><th>Closed</th><td>${machine.closedBy === null ? "open" : html`<code>${machine.closedBy}</code>`}</td></tr>
<tr><th>Exception</th><td>${machine.exploratory ? "recorded: the case is marked exploratory, and nothing clears the mark" : "none recorded"}</td></tr>
<tr><th>Visits on an exception</th><td>${exceptionVisits.length === 0 ? "none" : exceptionVisits.join(", ")}</td></tr>
<tr><th>Plan</th><td>${machine.planDigest === null ? "not frozen" : html`frozen as ${linkToEvidence(caseId, machine.planDigest)}`}</td></tr>
<tr><th>Baseline rule</th><td><code>${machine.baselineRule}</code></td></tr>
<tr><th>Next attempt</th><td><code>${continuation.continuation}</code>${continuation.continuation === "blocked" ? html`, cleanup unresolved for ${continuation.slots.join(", ")}` : ""}</td></tr>
<tr><th>Raw tier</th><td><code>${retentionOf(machine)}</code></td></tr>
</table>`;

  const denominator = html`<table><tr>${(Object.keys(counts) as (keyof typeof counts)[]).map((key) => html`<th>${key}</th>`)}</tr><tr>${(Object.keys(counts) as (keyof typeof counts)[]).map((key) => html`<td>${counts[key]}</td>`)}</tr></table>`;

  const configurations = html`<table><tr><th></th><th>Commit</th><th>REA release</th><th>Runner image</th><th>Chromium</th><th>Instruments</th></tr>${state.configurations.map((identity, index) => html`<tr><td>configuration ${index + 1}${configurationKey(identity) === machine.configuration ? " (in force)" : ""}</td><td><code>${identity.commit}</code></td><td>${identity.reaRelease}</td><td><code>${identity.runnerImage}</code></td><td>${identity.chromium}</td><td>${identity.instruments.join(", ")}</td></tr>`)}</table>`;

  const attempts = html`<table><tr><th>Slot</th><th>Arm</th><th>Phase</th><th>Cleanup</th><th>Configuration</th><th>Visit rested on</th><th>Rows</th></tr>${machine.attempts.map(
    (attempt) =>
      html`<tr><td>${linkTo(["cases", caseId, "attempts", attempt.slot], attempt.slot)}</td><td>${attempt.arm}</td><td><code>${attempt.phase}</code></td><td>${attempt.cleanup === null ? "none yet" : html`<code>${attempt.cleanup}</code>`}</td><td>${configurationName(state, attempt.configuration)}</td><td>${basisMarkup(state, attempt)}</td><td>${record.rows.filter(({ slot }) => slot === attempt.slot).length}</td></tr>`
  )}</table>`;

  const facts = html`${record.facts.length === 0 ? html`<p class="muted">No facts.</p>` : record.facts.map((fact) => html`<section><h3>${linkTo(["cases", caseId, "facts", fact.id], fact.id)}</h3><p>Version ${fact.version}, ${fact.status === "current" ? "current" : html`<span class="flag">retracted</span>`}.</p>${textBlock(fact.statement)}<p>Evidence: ${joined(fact.links.map((link) => linkTo(rowPath(caseId, { slot: link.slot, id: link.evidence }), `${link.slot} ${link.evidence}`)))}</p></section>`)}`;

  const interpretations = html`${record.interpretations.length === 0 ? html`<p class="muted">No interpretations.</p>` : record.interpretations.map((interpretation) => interpretationSection(caseId, view, state, interpretation))}`;

  const assertions = html`${record.assertions.length === 0 ? html`<p class="muted">No assertions.</p>` : record.assertions.map((assertion) => html`<section><h3>${assertion.id}</h3>${textBlock(assertion.statement)}<p>${assertion.status === "unverified" ? "Unverified" : html`<span class="flag">Retracted</span>`}. Not citable: an assertion is what someone said, and nothing checked it.</p>${assertion.retraction === null ? postForm(["cases", caseId, "assertions", assertion.id, "retract"], view.head, "Retract assertion", html`${areaField("reason", "Why it is retracted")}${unknownFields(true)}`) : html`<p>Retracted: </p>${textBlock(assertion.retraction.reason)}<p>It left the unknown <code>${assertion.retraction.replacedByUnknown}</code>.</p>`}</section>`)}`;

  const unknowns = html`${record.unknowns.length === 0 ? html`<p class="muted">No unknowns.</p>` : html`<table><tr><th>Id</th><th>Question</th><th>Why it is unknown</th><th>Detail</th><th>What would resolve it</th></tr>${record.unknowns.map((unknown) => html`<tr><td><code>${unknown.id}</code></td><td>${textBlock(unknown.question)}</td><td>${textBlock(unknown.reason)}</td><td>${unknown.detail === null ? "" : textBlock(unknown.detail)}</td><td>${unknown.wouldResolve === null ? "" : textBlock(unknown.wouldResolve)}</td></tr>`)}</table>`}`;

  const keptObjects = html`${state.keptObjects.length === 0 ? html`<p class="muted">None.</p>` : html`<ul>${state.keptObjects.map((digest) => html`<li>${linkToEvidence(caseId, digest)}</li>`)}</ul>`}`;

  const writes = html`<h2>Write a claim</h2>
${postForm(["cases", caseId, "facts"], view.head, "Record fact", html`${textField("id", "Fact id")}${areaField("statement", "Statement")}<fieldset><legend>The rows it rests on</legend>${record.rows.map((row) => html`<label><input type="checkbox" name="evidence" value="${attribute(row.id)}"> ${row.slot} ${row.id} (<code>${row.state}</code>)</label>`)}</fieldset>`)}
${postForm(["cases", caseId, "assertions"], view.head, "Record assertion", html`${textField("id", "Assertion id")}${areaField("statement", "What was said")}`)}
${postForm(["cases", caseId, "interpretations"], view.head, "Record interpretation", html`${textField("id", "Interpretation id")}${areaField("statement", "Statement")}<fieldset><legend>The current facts it cites, at their current versions</legend>${currentFacts.length === 0 ? html`<span class="muted">No current facts.</span>` : currentFacts.map((fact) => html`<label><input type="checkbox" name="cite" value="${attribute(`${fact.id}:${fact.version}`)}"> ${fact.id}, version ${fact.version}</label>`)}</fieldset>`)}`;

  const body = html`<h1>Case ${caseId}</h1>${overview}
<h2>Attempts</h2>${attempts}<h3>Denominator</h3>${denominator}
<h2>Configurations</h2>${configurations}
<h2>Facts</h2>${facts}
<h2>Interpretations</h2>${interpretations}
<h2>Assertions</h2>${assertions}
<h2>Unknowns</h2>${unknowns}
<h2>Objects this case keeps</h2>${keptObjects}
${writes}`;
  return documentOf(`Case ${caseId}`, caseId, body, noticeOf(notice));
}

/** One attempt's evidence, each row with its reading. Never more than one attempt. */
export function attemptPage(view: CaseView, slot: string): string | null {
  const state = view.state;
  if (state === null) return null;
  const attempt = attemptOf(state.machine, slot);
  if (attempt === null) return null;
  const evidence = evidenceForAttempt(state.machine, state.record, [attempt.slot]);
  if (!evidence.ok) return null;
  const rows = html`${evidence.rows.length === 0 ? html`<p class="muted">No rows.</p>` : html`<table><tr><th>Row</th><th>Instrument</th><th>State</th><th>Window</th><th>Limits as captured</th><th>Reading</th></tr>${evidence.rows.map((row) => html`<tr><td>${linkTo(rowPath(view.caseId, row), row.id)}</td><td><code>${row.instrument}</code></td><td><code>${row.state}</code></td><td>${windowMarkup(row.window)}</td><td>${limitList(row.limits)}</td><td>${readingMarkup(row.reading)}</td></tr>`)}</table>`}`;
  const began = attempt.phase !== "planned" && attempt.phase !== "not_started";
  const lead = began ? html`<p>One attempt's evidence, from one execution. Counts across attempts are on their own page.</p>` : html`<p>No visit began in this slot, so there was no execution and there is no evidence to show.</p>`;
  const body = html`<h1>Attempt ${attempt.slot} of case ${view.caseId}</h1>${lead}${attemptHeader(view.caseId, state, attempt)}<h2>Rows</h2>${rows}`;
  return documentOf(`Attempt ${attempt.slot}, case ${view.caseId}`, view.caseId, body);
}

/** One row, inside its own attempt. Null when the row is not this attempt's. */
export function rowPage(view: CaseView, slot: string, rowId: string): string | null {
  const state = view.state;
  if (state === null) return null;
  const row = state.record.rows.find((candidate) => candidate.id === rowId && candidate.slot === slot);
  const attempt = attemptOf(state.machine, slot);
  if (row === undefined || attempt === null) return null;
  const citing = state.record.facts.flatMap((fact) => fact.links.filter((link) => link.evidence === row.id).map((link) => ({ fact, link })));
  const body = html`<h1>Row ${row.id}</h1><p>In attempt ${linkTo(["cases", view.caseId, "attempts", attempt.slot], attempt.slot)} of case ${view.caseId}.</p>
<h2>The attempt</h2>${attemptHeader(view.caseId, state, attempt)}
<h2>The row</h2><table>
<tr><th>Instrument</th><td><code>${row.instrument}</code></td></tr>
<tr><th>State</th><td><code>${row.state}</code></td></tr>
<tr><th>Window and clock</th><td>${windowMarkup(row.window)}</td></tr>
<tr><th>Limits as captured</th><td>${limitList(row.limits)}</td></tr>
<tr><th>What it counted</th><td>${row.observation === null ? html`<span class="muted">nothing: this row holds bytes, not a count</span>` : html`subject <code>${row.observation.subject}</code>, scope <code>${row.observation.scope}</code>`}</td></tr>
<tr><th>Reading now</th><td>${readingMarkup(readRow(state.record, state.machine, row))}</td></tr>
<tr><th>Bytes</th><td>${row.digest === null ? html`<span class="muted">none: only a present row holds bytes</span>` : linkToEvidence(view.caseId, row.digest)}</td></tr>
</table>
<h2>Facts resting on it</h2>${citing.length === 0 ? html`<p class="muted">None.</p>` : html`<table><tr><th>Fact</th><th>Limits when the fact was recorded</th></tr>${citing.map(({ fact, link }) => html`<tr><td>${linkTo(["cases", view.caseId, "facts", fact.id], fact.id)} (version ${fact.version}, ${fact.status})</td><td>${limitList(link.limits)}</td></tr>`)}</table>`}`;
  return documentOf(`Row ${row.id}, case ${view.caseId}`, view.caseId, body);
}

/** One fact: its wording and history, and each row it rests on with the limits then beside the reading now. */
export function factPage(view: CaseView, factId: string): string | null {
  const state = view.state;
  if (state === null) return null;
  const fact = factOf(state.record, factId);
  if (fact === null) return null;
  const links = html`<table><tr><th>Row</th><th>Instrument</th><th>Window and clock</th><th>Limits when this fact was recorded</th><th>The row's reading now</th></tr>${fact.links.map((link) => {
    const row = state.record.rows.find((candidate) => candidate.id === link.evidence);
    return html`<tr><td>${linkTo(rowPath(view.caseId, { slot: link.slot, id: link.evidence }), `${link.slot} ${link.evidence}`)}</td><td><code>${link.instrument}</code></td><td>${windowMarkup(link.window)}</td><td>${limitList(link.limits)}</td><td>${row === undefined ? html`<span class="muted">no such row</span>` : readingMarkup(readRow(state.record, state.machine, row))}</td></tr>`;
  })}</table>`;
  const history = html`${fact.history.length === 0 ? html`<p class="muted">No earlier versions.</p>` : html`<table><tr><th>Version</th><th>Wording then</th><th>Why it changed</th><th>Entry</th></tr>${fact.history.map((entry) => html`<tr><td>${entry.version}</td><td>${textBlock(entry.statement)}</td><td>${textBlock(entry.reason)}</td><td>${entry.atSeq}</td></tr>`)}</table>`}`;
  const citing = state.record.interpretations.filter((interpretation) => interpretation.cites.some((cite) => cite.fact === fact.id));
  const corrections =
    fact.status === "current"
      ? html`<h2>Correct it</h2><p>A supersede or a retraction keeps every row and the old wording, and flags each interpretation that cites this fact.</p>
${postForm(["cases", view.caseId, "facts", fact.id, "supersede"], view.head, "Supersede", html`${areaField("statement", "New wording")}${areaField("reason", "Why it changes")}`)}
${postForm(["cases", view.caseId, "facts", fact.id, "retract"], view.head, "Retract", html`${areaField("reason", "Why it is retracted")}${unknownFields(false)}`)}`
      : html`<p class="flag">Retracted at entry ${(fact.retraction as NonNullable<Fact["retraction"]>).atSeq}.</p>${textBlock((fact.retraction as NonNullable<Fact["retraction"]>).reason)}`;
  const body = html`<h1>Fact ${fact.id}</h1><p>Version ${fact.version}, ${fact.status === "current" ? "current" : html`<span class="flag">retracted</span>`}.</p>${textBlock(fact.statement)}
<h2>Evidence</h2><p>Each link opens the row inside its own attempt. The limits beside it are a snapshot taken when this fact was recorded. The reading beside that is the row's reading now.</p>${links}
<h2>History</h2>${history}
<h2>Interpretations citing it</h2>${citing.length === 0 ? html`<p class="muted">None.</p>` : html`<ul>${citing.map((interpretation) => html`<li><code>${interpretation.id}</code>: ${interpretation.review === "needs_review" ? html`<span class="flag">needs review</span>` : "current"}</li>`)}</ul>`}
${corrections}`;
  return documentOf(`Fact ${fact.id}, case ${view.caseId}`, view.caseId, body);
}

function groupMarkup(state: CaseState, group: AggregateGroup): Markup {
  const keys = group.group;
  const limits = (["observed", "zero_in_window", "unknown"] as const).map((reading) => {
    const entries = Object.entries(group.limits[reading]);
    return entries.length === 0 ? html`` : html`<li>${reading}: ${joined(entries.map(([limit, count]) => html`<code>${limit}</code> on ${count}`))}</li>`;
  });
  return html`<tr><td><code>${keys.arm}</code></td><td>${keys.release}</td><td><code>${keys.commit}</code></td><td>${configurationName(state, keys.configuration)}</td><td>${keys.basis === "ordinary" ? html`<code>ordinary</code>: a visit on the met control, or a slot no visit reached` : html`<code>${keys.basis}</code>`}</td><td>${group.n}</td><td>${group.zero}</td><td>${group.unknown}</td><td>${group.of}</td><td>${group.notStarted}</td><td>${group.failed}</td><td><ul class="limits">${limits}</ul></td><td>${group.presentedAs}</td></tr>`;
}

/** Counts across attempts, one table per subject the rows count, split by arm, release, commit, configuration and what each visit rested on. */
export function aggregatesPage(view: CaseView): string {
  const state = view.state;
  if (state === null) return casePage(view);
  const rows = aggregateRowsOfCase(state);
  const subjects = [...new Set(state.record.rows.flatMap(({ observation }) => (observation === null ? [] : [observation.subject])))].sort();
  const tables = subjects.map((subject) => {
    const measure: Measure = { id: "by-arm", subject, population: null, keys: { heldEqual: ["arm", "commit", "configuration", "release"], allowedToVary: [], unknown: [] } };
    const result = aggregate(rows, measure);
    if (!result.ok) return html`<h2><code>${subject}</code></h2><p class="flag">These attempts cannot be counted together: <code>${refusalName(result.refusal)}</code>${refusalPlace(result.at)}.</p>`;
    return html`<h2><code>${subject}</code></h2><table><tr><th>Arm</th><th>REA release</th><th>Commit</th><th>Configuration</th><th>Basis</th><th>Observed</th><th>Zero</th><th>Unknown</th><th>Of attempts</th><th>Not started</th><th>Failed</th><th>Limits, by reading</th><th>Presented as</th></tr>${result.groups.map((group) => groupMarkup(state, group))}</table>`;
  });
  const body = html`<h1>Counts across attempts, case ${view.caseId}</h1><p>Each count is an aggregate across attempts, not one execution. Its denominator is every attempt in its group, including those that never started or failed, and observed, zero and unknown add up to it. Unknown is never counted as zero. A group's basis is exception, for visits that rested on one, or ordinary, for visits on the met control and for slots no visit reached, and the two never pool. Each attempt's own evidence is on its attempt's page.</p>${subjects.length === 0 ? html`<p class="muted">No row counts anything.</p>` : tables}`;
  return documentOf(`Counts, case ${view.caseId}`, view.caseId, body);
}

function byteTokens(bytes: readonly number[]): Markup {
  return html`${bytes.map((byte) => html`<span class="ctl">byte 0x${byte.toString(16).toUpperCase().padStart(2, "0")}</span>`)}`;
}

/** One page of an evidence object's bytes as text. Shown, never run, and nothing in it is a link. */
export function evidencePage(caseId: string, page: EvidencePage): string {
  const segments = ["cases", caseId, "evidence", page.digest];
  const previous = page.previous === null ? html`` : linkTo(segments, "Previous page", `?offset=${page.previous}`);
  const next = page.end < page.total ? linkTo(segments, "Next page", `?offset=${page.end}`) : html``;
  const leading = page.leadingBytes.length;
  const notes = [
    page.validUtf8 ? null : "This object is not all UTF-8, so each bad sequence in it shows as a replacement character.",
    leading === 0 ? null : page.leadingEndsCharacter ? `This page starts inside a character: its first ${leading} bytes end a character the page before holds, and show as bytes.` : `This page starts with ${leading} stray continuation bytes that finish no character, shown as bytes.`,
    page.trailingBytes.length === 0 ? null : `This page ends inside a character: its last ${page.trailingBytes.length} bytes begin one it does not hold, and show as bytes.`
  ].filter((note): note is string => note !== null);
  // A line feed right after <pre> is dropped by the parser, so one is written there for it to drop.
  const body = html`<h1>Evidence object</h1><p><code>${page.digest}</code></p>
<p>Bytes ${page.offset} to ${page.end} of ${page.total}, decoded as UTF-8. This is text: nothing in it runs, and nothing in it is a link. A control, format, private-use, unassigned, default-ignorable or blank code point, other than a plain space or tab, shows as its code point, such as <span class="ctl">U+202E</span>. A space or tab shows as itself only alone inside a line, or in indentation of spaces alone or tabs alone, at most ${MAX_INDENT}, at the start of a line or of the page, with text after it on that line. Every other run of spaces and tabs shows as a count, such as <span class="ctl">2 spaces 1 tab</span>: two or more inside a line, any run that ends a line or the page, a line of nothing else, mixed indentation, and indentation longer than ${MAX_INDENT}. Right-to-left text shows in the order it is stored.${notes.map((note) => ` ${note}`)}</p>
<nav>${previous}${next}</nav><pre>
${byteTokens(page.leadingBytes)}${page.text}${byteTokens(page.trailingBytes)}</pre><nav>${previous}${next}</nav>`;
  return documentOf(`Evidence, case ${caseId}`, caseId, body);
}

/** A case that will not open, by the refusal's name and place. No value it held is shown. */
export function refusalPage(caseId: string, refusal: string, at: string | null): string {
  const body = html`<h1>Case ${caseId} will not open</h1><p>The log refused it: <code>${refusalName(refusal)}</code>${refusalPlace(at)}.</p><p>Nothing in it is shown, since what a refused log holds cannot be trusted. Nothing was written.</p>`;
  return documentOf(`Case ${caseId} refused`, caseId, body);
}

/** A form that could not be read, by the field it failed at, or why the whole of it was refused. Nothing it held is shown. */
export function formRefusalPage(caseId: string, refusal: string, field: string | null, why: string | null = null): string {
  const body = html`<h1>That form could not be read</h1><p><code>${refusalName(refusal)}</code>${refusalPlace(field)}.${why === null ? "" : ` ${why}`} Nothing was written.</p><p>${linkTo(["cases", caseId], "Back to the case")}</p>`;
  return documentOf(`Form refused, case ${caseId}`, caseId, body);
}

export function methodPage(): string {
  return documentOf("Method not allowed", null, html`<h1>Method not allowed</h1><p>That address does not take this method.</p>`);
}

export function notFoundPage(): string {
  return documentOf("Not found", null, html`<h1>Not found</h1><p>No page of the workspace is at that address.</p>`);
}

export function evidenceRefusalPage(caseId: string, refusal: string): string {
  const body = html`<h1>That evidence is not shown</h1><p><code>${refusalName(refusal)}</code>.</p><p>${linkTo(["cases", caseId], "Back to the case")}</p>`;
  return documentOf(`Evidence refused, case ${caseId}`, caseId, body);
}
