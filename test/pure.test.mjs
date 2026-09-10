/**
 * Unit tests for the plugin's dependency-free decision logic
 * (`lib/pure.js`). Run with `npm test` (node --test).
 *
 * These cover exactly the parts that silently decide whether an escalation is
 * auto-approved, so a regression here is a security regression:
 *   - rule matching + the deny-before-allow ordering,
 *   - the regex/substring form (a path substring must NOT become a regex),
 *   - blanket-allow detection,
 *   - evidence rendering (head+tail, so a dangerous tail cannot be hidden),
 *   - the session-id display fragment.
 *
 * `lib/pure.js` imports nothing, so this suite needs no DSH packages and no
 * installed node_modules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_LIMIT,
  RECORD_ARGS_LIMIT,
  errText,
  evidenceText,
  isBlanketAllow,
  isTruncatedEvidence,
  matchRules,
  newRuleId,
  ruleMatches,
  ruleRegex,
  shortId,
  trunc,
} from "../lib/pure.js";

// ---- shortId ----------------------------------------------------------------

test("shortId strips the session- prefix before taking 8 chars", () => {
  const uuid = "886106a4-1111-2222-3333-444455556666";
  assert.equal(shortId("session-" + uuid), "886106a4");
  // Subagent run ids carry no prefix and must be unaffected.
  assert.equal(shortId(uuid), uuid.slice(0, 8));
  assert.equal(shortId("session-"), "");
  assert.equal(shortId(undefined), "undefine");
});

// ---- trunc ------------------------------------------------------------------

test("trunc passes short strings through and marks long ones", () => {
  assert.equal(trunc("abc", 5), "abc");
  assert.equal(trunc("abcdef", 3), "abc…[truncated]");
  assert.equal(trunc(undefined, 3), "");
  assert.equal(trunc(42, 3), "");
});

test("errText survives non-errors", () => {
  assert.equal(errText(new Error("boom")), "boom");
  assert.equal(errText("plain"), "plain");
  assert.equal(errText(undefined), "undefined");
});

// ---- ruleRegex: the regex/substring form ------------------------------------

test("ruleRegex only treats /…/… as a regex when the closing slash is followed by legal flags", () => {
  assert.ok(ruleRegex("/foo/") instanceof RegExp);
  assert.ok(ruleRegex("/foo/i") instanceof RegExp);
  assert.ok(ruleRegex("/foo/gi") instanceof RegExp);
  // "x" is not a legal JS flag → the whole string is a plain substring, so the
  // rule matches that literal text instead of silently becoming a regex.
  assert.equal(ruleRegex("/foo/x"), undefined);
  assert.equal(ruleMatches({ tool: "t", match: "/foo/x" }, "t", '{"a":"/foo/x"}'), true);
  assert.equal(ruleMatches({ tool: "t", match: "/foo/x" }, "t", '{"a":"foodx"}'), false);
});

test("ruleRegex leaves path substrings alone (no silent regex widening)", () => {
  // These are the exact shapes a user types to whitelist a path. The OLD
  // implementation fed them to `new RegExp(body, <tail>)`, which threw on the
  // bogus flag string and returned null — so such a rule silently NEVER
  // matched (an allow rule quietly failed; a deny rule quietly let everything
  // through). They must now be plain substrings.
  for (const substring of [
    "/usr/bin",
    "/tmp/x.log",
    "/etc/passwd",
    "/a.b/c",
    "/C:/Users/x",
    "/i",
  ]) {
    assert.equal(ruleRegex(substring), undefined, substring + " must stay a substring");
    // A substring rule must match that literal text in the arguments JSON.
    assert.equal(
      ruleMatches({ tool: "t", match: substring }, "t", '{"command":"x ' + substring + ' y"}'),
      true,
      substring + " must match its own literal text",
    );
  }
  assert.equal(ruleRegex(""), undefined);
  assert.equal(ruleRegex("plain"), undefined);
  assert.equal(ruleRegex(undefined), undefined);
});

test("ruleRegex: a path whose tail IS a legal flag stays regex-shaped (documented ambiguity)", () => {
  // `/usr/i` is indistinguishable from "regex /usr/ with flag i" — no
  // heuristic can split them, so this is pinned as intended behaviour rather
  // than left to drift. To match such a path literally, write it without the
  // surrounding slashes (`usr/i`), which is a substring rule.
  assert.ok(ruleRegex("/usr/i") instanceof RegExp);
  assert.equal(ruleMatches({ tool: "t", match: "/usr/i" }, "t", '{"c":"usrX"}'), true);
  assert.equal(ruleMatches({ tool: "t", match: "usr/i" }, "t", '{"c":"usrX"}'), false);
  assert.equal(ruleMatches({ tool: "t", match: "usr/i" }, "t", '{"c":"cat /usr/i"}'), true);
});

test("ruleRegex returns null for an invalid pattern", () => {
  assert.equal(ruleRegex("/[unclosed/"), null);
  assert.equal(ruleRegex("/(a/"), null);
});

test("ruleRegex keeps a slash inside the pattern body", () => {
  // Assert behaviour, not `.source` (which re-escapes "/" for literal embedding).
  assert.equal(ruleRegex("/a\\/b/").test("a/b"), true);
  assert.equal(ruleRegex("/a/b/").test("a/b"), true);
  assert.equal(ruleRegex("/a/b/").test("aXb"), false);
});

// ---- ruleMatches ------------------------------------------------------------

test("ruleMatches: empty match means every call of that tool", () => {
  assert.equal(ruleMatches({ tool: "pwsh", match: "" }, "pwsh", "{}"), true);
  assert.equal(ruleMatches({ tool: "pwsh", match: "" }, "bash", "{}"), false);
  // "" widens to every tool only when the rule itself says tool "*".
  assert.equal(ruleMatches({ tool: "*", match: "" }, "anything", undefined), true);
});

test("ruleMatches: substring form tests the raw arguments JSON", () => {
  const rule = { tool: "pwsh", match: '"sandbox_permissions"' };
  assert.equal(ruleMatches(rule, "pwsh", '{"command":"x","sandbox_permissions":"y"}'), true);
  assert.equal(ruleMatches(rule, "pwsh", '{"command":"x"}'), false);
  // Unknown arguments (no tool/call event) must not accidentally match a
  // non-empty substring.
  assert.equal(ruleMatches(rule, "pwsh", undefined), false);
});

test("ruleMatches: regex form", () => {
  const rule = { tool: "pwsh", match: "/^\\{\"command\":\"git /" };
  assert.equal(ruleMatches(rule, "pwsh", '{"command":"git status"}'), true);
  assert.equal(ruleMatches(rule, "pwsh", '{"command":"rm -rf /"}'), false);
});

test("ruleMatches: an invalid regex never matches", () => {
  assert.equal(ruleMatches({ tool: "pwsh", match: "/[bad/" }, "pwsh", "[bad"), false);
});

// ---- matchRules: deny-before-allow ordering ---------------------------------

test("matchRules lets a later deny beat an earlier allow", () => {
  const allow = { id: "a", effect: "allow", tool: "pwsh", match: "git" };
  const deny = { id: "d", effect: "deny", tool: "pwsh", match: "push" };
  const args = '{"command":"git push"}';
  // Both hit; deny must win regardless of table order.
  assert.equal(matchRules([allow, deny], "pwsh", args).id, "d");
  assert.equal(matchRules([deny, allow], "pwsh", args).id, "d");
});

test("matchRules returns the first hitting allow", () => {
  const a1 = { id: "a1", effect: "allow", tool: "pwsh", match: "git" };
  const a2 = { id: "a2", effect: "allow", tool: "pwsh", match: "status" };
  assert.equal(matchRules([a1, a2], "pwsh", '{"command":"git status"}').id, "a1");
  assert.equal(matchRules([a1, a2], "pwsh", '{"command":"ls"}'), undefined);
});

// ---- blanket allow ----------------------------------------------------------

test("isBlanketAllow only flags the allow-everything shape", () => {
  assert.equal(isBlanketAllow("allow", "*", ""), true);
  assert.equal(isBlanketAllow("deny", "*", ""), false); // lockdown stays legal
  assert.equal(isBlanketAllow("allow", "*", "git"), false);
  assert.equal(isBlanketAllow("allow", "pwsh", ""), false);
});

// ---- evidence rendering -----------------------------------------------------

test("evidenceText returns short arguments untouched", () => {
  assert.equal(evidenceText('{"a":1}', EVIDENCE_LIMIT), '{"a":1}');
  assert.equal(evidenceText("", EVIDENCE_LIMIT), "");
  assert.equal(evidenceText(undefined, EVIDENCE_LIMIT), undefined);
  assert.equal(evidenceText({ a: 1 }, EVIDENCE_LIMIT), undefined);
});

test("evidenceText keeps the TAIL of an over-long command (the dangerous end)", () => {
  const danger = "; Remove-Item -Recurse -Force C:\\important";
  const padding = "x".repeat(EVIDENCE_LIMIT * 2);
  const rendered = evidenceText(padding + danger, EVIDENCE_LIMIT);
  assert.ok(rendered.includes(danger), "the tail must stay visible");
  assert.ok(rendered.length <= EVIDENCE_LIMIT + 40, "budget respected: " + rendered.length);
  assert.ok(isTruncatedEvidence(rendered));
});

test("evidenceText keeps the HEAD too, and respects the record budget", () => {
  const args = "y".repeat(RECORD_ARGS_LIMIT * 3);
  const rendered = evidenceText(args, RECORD_ARGS_LIMIT);
  assert.ok(rendered.startsWith("y".repeat(100)));
  assert.ok(rendered.length <= RECORD_ARGS_LIMIT + 40);
});

test("evidenceText reports the number of omitted characters", () => {
  const args = "z".repeat(100);
  const rendered = evidenceText(args, 10);
  // head 6 + marker + tail 4
  assert.ok(rendered.includes("[90 chars omitted]"), rendered);
  assert.equal(rendered.slice(0, 6), "zzzzzz");
  assert.equal(rendered.slice(-4), "zzzz");
});

test("isTruncatedEvidence detects both markers and rejects ordinary text", () => {
  assert.equal(isTruncatedEvidence('{"a":"…[12 chars omitted]…"}'), true);
  assert.equal(isTruncatedEvidence("some text…[truncated]"), true);
  assert.equal(isTruncatedEvidence('{"command":"git status"}'), false);
  assert.equal(isTruncatedEvidence(""), false);
  assert.equal(isTruncatedEvidence(undefined), false);
});

// ---- newRuleId --------------------------------------------------------------

test("newRuleId is unique and non-empty", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(newRuleId());
  assert.equal(ids.size, 200);
  for (const id of ids) assert.ok(typeof id === "string" && id.length > 0);
});
