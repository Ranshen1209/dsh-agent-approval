/**
 * dsh-agent-approval — dependency-free decision helpers.
 *
 * Everything in this module is pure: no Cordis, no DSH services, no I/O. It is
 * split out of `index.js` so the security-relevant logic (rule matching, the
 * regex/substring form, evidence truncation, id display) can be unit-tested
 * without loading the harness, and so `index.js` stays service wiring.
 *
 * The host half imports this file; the CLIENT half cannot (it is a browser
 * bundle loaded through `window.__ModuleLoader__.load`), so the few constants
 * it must agree on — the evidence omission marker — are mirrored there with a
 * comment. Keep both in sync when changing the marker format.
 */

// ---- ids, truncation, errors ------------------------------------------------

/**
 * DSH prefixes session ids with the literal `"session-"` before the UUID (see
 * `@deepseek-ai/dsh-host-apiproxy` `session create` and `@deepseek-ai/dsh-headless`
 * `SessionId(\`session-${randomUUID()}\`)`); a naive `slice(0, 8)` lands on that
 * meaningless 8-char prefix and every audit row shows nothing but `"session-"`.
 * Strip the known prefix before truncating so the displayed fragment comes from
 * the UUID proper; id shapes without the prefix (subagent `run.id` = raw
 * `randomUUID()`) are unaffected. Do NOT change this back to a naive slice.
 */
export const SESSION_ID_PREFIX = "session-";

/**
 * First 8 chars of a session / run id (display form in records and chips).
 * @param id - session or subagent run id.
 * @returns the display fragment.
 */
export function shortId(id) {
  const s = String(id);
  const tail = s.startsWith(SESSION_ID_PREFIX) ? s.slice(SESSION_ID_PREFIX.length) : s;
  return tail.slice(0, 8);
}

/**
 * Truncate a long string for one-line audit fields; pass through non-strings
 * as "". Prefix-only: use {@link evidenceText} where the TAIL matters.
 * @param value - candidate text.
 * @param n - maximum length kept.
 * @returns the truncated text.
 */
export function trunc(value, n) {
  if (typeof value !== "string") return "";
  return value.length > n ? value.slice(0, n) + "…[truncated]" : value;
}

/** Best-effort error text. */
export function errText(e) {
  return e && typeof e.message === "string" ? e.message : String(e);
}

// ---- evidence rendering (judge prompt + audit args) -------------------------

/** Character budget for the argument evidence shown to the approval agent. */
export const EVIDENCE_LIMIT = 4000;
/** Character budget for the argument evidence kept in the audit record. */
export const RECORD_ARGS_LIMIT = 2000;
/**
 * Marker inserted where the middle of an over-long argument string was
 * dropped. A PREFIX-ONLY cut is a security hole here: the requesting agent
 * controls its own arguments, so it could pad a harmless prefix to push a
 * destructive tail past the cut while the harness still executes the whole
 * string. Keeping head AND tail keeps the dangerous end visible; the marker is
 * also what tells the judge (and the audit reader) that the evidence is
 * incomplete. Mirrored in `client.js` — keep the format in sync.
 */
export const EVIDENCE_OMITTED_PATTERN = /\[\d+ chars omitted\]/;

/**
 * Render argument evidence that stays safe when it does not fit: the head and
 * the TAIL are kept and the dropped middle is marked.
 * @param argsRaw - raw tool-call arguments JSON, or a non-string when unknown.
 * @param limit - character budget.
 * @returns the rendered evidence, `""` for empty input, or `undefined` when the
 *   arguments are unavailable (the caller must treat that as incomplete).
 */
export function evidenceText(argsRaw, limit) {
  if (typeof argsRaw !== "string") return undefined;
  if (argsRaw === "") return "";
  const n = typeof limit === "number" && limit > 0 ? Math.floor(limit) : EVIDENCE_LIMIT;
  if (argsRaw.length <= n) return argsRaw;
  const head = Math.ceil(n * 0.6);
  const tail = n - head;
  const omitted = argsRaw.length - head - tail;
  // `slice(-0)` is `slice(0)` — i.e. the WHOLE string — so a zero-length tail
  // must be emitted as empty, never as a negative-zero slice. Otherwise a
  // tiny budget would return the entire argument string and silently undo the
  // very truncation this function exists to make honest.
  const tailText = tail > 0 ? argsRaw.slice(-tail) : "";
  return argsRaw.slice(0, head) + "\n…[" + omitted + " chars omitted]…\n" + tailText;
}

/**
 * Whether rendered evidence was cut (either this version's middle-omission
 * marker or the legacy prefix marker written by 1.5.x hosts).
 * @param text - rendered argument evidence.
 * @returns whether the text is known to be incomplete.
 */
export function isTruncatedEvidence(text) {
  if (typeof text !== "string") return false;
  return EVIDENCE_OMITTED_PATTERN.test(text) || text.endsWith("…[truncated]");
}

// ---- approval outcomes ------------------------------------------------------

/** The wire's closed outcome vocabulary (mirrors the Typert result schema). */
export const APPROVAL_OUTCOMES = ["allowed-once", "rejected", "cancelled", "unavailable"];

/**
 * Whether a value is a valid approval outcome. Used when reading the audit
 * sidecar: one malformed line (a hand-edited or older file) must not be able
 * to fail the strict wire enum and thereby break the whole「审批」tab.
 * @param value - candidate outcome.
 * @returns whether it is one of the four legal values.
 */
export function isApprovalOutcome(value) {
  return APPROVAL_OUTCOMES.indexOf(value) !== -1;
}

// ---- session classification -------------------------------------------------

/**
 * Whether a session HEADER marks a child created by DELEGATION (spawn/fork
 * subagent) rather than a session the user started or forked themselves.
 *
 * Only `@deepseek-ai/dsh-subagent`'s `childSessionMeta` sets `origin:
 * "subagent"`, and it sets it on every child it creates; the harness uses the
 * same single test (`dsh-api-session-controller` `hasApiSessionSubagentOwner`).
 *
 * MUST NOT also match on `parentSession`: a USER fork of a normal session is
 * created with `meta.parentSession = <source id>` and NO `origin`
 * (`dsh-api-session-controller` session fork), so matching `parentSession`
 * would treat the user's own fork as a delegated child — its inherited
 * `permission/preset: agent-approval` would then never re-arm, leaving the
 * permission menu showing the preset as selected while nothing judges.
 *
 * @param header - a session header (or anything else).
 * @returns whether this is a delegation-created child.
 */
export function isDelegatedChildHeader(header) {
  if (header === null || typeof header !== "object") return false;
  return header.origin === "subagent";
}

// ---- deterministic rules ----------------------------------------------------

/** Legal `RegExp` flags for the `/pattern/flags` rule form. */
const REGEX_FLAGS = /^[dgimsuvy]*$/;

/**
 * Compile a rule's `match`:
 *
 *   - `""`               → every call of the rule's tool (handled by the caller);
 *   - `"/pattern/flags"` → a regular expression;
 *   - anything else      → a plain substring of the raw arguments JSON.
 *
 * The regex form requires the string to start with `/`, to contain a closing
 * `/`, and to have ONLY legal regex flags after that closing slash. Without the
 * flag check, a path-like substring goes wrong in one of two ways, both
 * verified by differential test against the old implementation:
 *
 *   - tail is NOT a legal flag string (`/usr/bin`, `/tmp/x.log`, `/etc/passwd`):
 *     `new RegExp(body, "bin")` throws, so the old code returned `null` and the
 *     rule matched NOTHING at all — an allow rule silently stopped allowing,
 *     and, worse, a DENY rule silently stopped denying;
 *   - tail IS a legal flag string (`/usr/i`, `/tmp/g`): the old code (and this
 *     one — the two forms are indistinguishable) built the regex `usr`/`tmp`,
 *     which is BROADER than the literal path the user wrote and can therefore
 *     auto-approve unrelated commands.
 *
 * The guard fixes the first case by falling back to a substring. The second is
 * an irreducible ambiguity: to match such a path literally, write it without the
 * surrounding slashes (`usr/i`), which is a substring rule.
 *
 * @param match - the rule's match expression.
 * @returns a RegExp for the regex form, `undefined` for the substring form, or
 *   `null` for an invalid regex (rejected at add time; a corrupt persisted rule
 *   that yields `null` simply never matches).
 */
export function ruleRegex(match) {
  if (typeof match !== "string" || match.length < 2 || match[0] !== "/") return undefined;
  const last = match.lastIndexOf("/");
  if (last <= 0) return undefined;
  const flags = match.slice(last + 1);
  if (!REGEX_FLAGS.test(flags)) return undefined;
  try {
    return new RegExp(match.slice(1, last), flags);
  } catch (e) {
    return null;
  }
}

/**
 * Whether one rule hits this exact call.
 * @param rule - `{ tool, match }` shape.
 * @param toolName - the tool requesting escalation.
 * @param argsRaw - raw tool-call arguments JSON, when known.
 * @returns whether the rule matches.
 */
export function ruleMatches(rule, toolName, argsRaw) {
  if (rule.tool !== "*" && rule.tool !== toolName) return false;
  if (rule.match === "") return true;
  const args = typeof argsRaw === "string" ? argsRaw : "";
  const re = ruleRegex(rule.match);
  if (re === null) return false;
  if (re !== undefined) return re.test(args);
  return args.indexOf(rule.match) !== -1;
}

/**
 * First hitting rule — every deny rule is evaluated before any allow rule may
 * win, so a later-added deny always overrides an earlier allow.
 * @param rules - the rule table.
 * @param toolName - the tool requesting escalation.
 * @param argsRaw - raw tool-call arguments JSON, when known.
 * @returns the winning rule, or undefined when nothing hits.
 */
export function matchRules(rules, toolName, argsRaw) {
  let allowHit;
  for (const rule of rules) {
    if (!ruleMatches(rule, toolName, argsRaw)) continue;
    if (rule.effect === "deny") return rule;
    if (allowHit === undefined) allowHit = rule;
  }
  return allowHit;
}

/**
 * Whether one allow rule would disable agent approval wholesale. A rule with
 * `tool: "*"` and an empty (or whitespace-only) `match` short-circuits EVERY
 * escalation of EVERY tool before the model runs — i.e. it is an off switch for
 * the whole control, reachable from the settings page in three clicks. Deny
 * rules are unaffected (a blanket deny is a legitimate lockdown).
 *
 * Whitespace is treated as empty on purpose: `match: " "` is a substring that
 * every JSON arguments object containing a space matches, so it is the same off
 * switch typed with one extra keystroke.
 *
 * Persisted tables are NOT filtered on load: hand-editing `config.json` stays
 * an explicit, informed act, and silently dropping a user's rule would be worse
 * than loading it.
 *
 * @param effect - `"allow"` or `"deny"`.
 * @param tool - exact tool name or `"*"`.
 * @param match - match expression.
 * @returns whether the rule is a blanket allow.
 */
export function isBlanketAllow(effect, tool, match) {
  return effect === "allow" && tool === "*" && String(match === undefined ? "" : match).trim() === "";
}

/**
 * New id for one rule (persisted, stable across restarts).
 * @returns a short unique id.
 */
export function newRuleId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
