// Check a DSH session log (zstd JSONL) for events the persistence seam would
// reject at load time: any envelope type outside KNOWN_SESSION_EVENT_TYPES
// that is not marked `ignorable: true` makes the whole log refuse to load
// ("unknown to this harness and not marked ignorable").
//
// v1 note: an earlier revision of this script split frames with a naive
// magic-scan and a placeholder bug, decoding only a subset of frames — it
// reported "no agent-approval/record events" for a log that contained three.
// The frame walk below mirrors the harness's structural
// (dsh-session-persistence-jsonl scanZstdFrames) so every frame is decoded.
//
// Vocabulary note: the event set is version-specific, and a stale copy makes
// the checker LIE — a type the installed harness knows gets reported as
// "would refuse to load", and a type it does not know gets reported as fine.
// The checker therefore prefers the INSTALLED harness's own export and only
// falls back to the snapshot below (verified against DSH 0.1.3-alpha.2) when
// `@deepseek-ai/dsh-session` is not resolvable from here.
//
// Usage: node scripts/check-session-log.mjs <session.jsonl.zstd> [...more]
// Library use: import { auditLog } from this module.
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const MAGIC = 0xfd2fb528;

/** Snapshot of `KNOWN_SESSION_EVENT_TYPES` for DSH 0.1.3-alpha.2. */
const FALLBACK_SESSION_EVENT_TYPES = [
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided",
  "approval/policy", "assistant/attempt", "assistant/message", "command/done", "command/run",
  "compaction/end", "compaction/prune", "compaction/start", "compaction/summary",
  "feedback/message-delete", "feedback/message-put", "feedback/record", "goal/change",
  "hook/invoked", "hook/result", "llm/retry", "llm/retry-started", "model/selection",
  "permission/preset", "plan/mode", "request/context", "request/header", "sandbox/mode",
  "schedule/change", "session-log-deepseek/delivery-accepted", "session/end-seed",
  "session/title", "session/title-llm-request", "step/end", "step/start",
  "subagent/descriptor", "subagent/model-selection-policy", "team/member",
  "team/message/delivered", "team/message/queued", "team/task", "todo/write",
  "tool-workflow/agent-end", "tool-workflow/agent-start", "tool-workflow/run-end",
  "tool-workflow/run-start", "tool/call", "tool/code-dispatch",
  "tool/code-dispatch-start", "tool/result", "turn/end", "turn/start", "user/message",
  "web/deepseek-search-llm-request",
];

/** Where the active vocabulary came from (reported by the CLI for honesty). */
export let eventTypeSource = "bundled snapshot (DSH 0.1.3-alpha.2)";
const KNOWN_SESSION_EVENT_TYPES = new Set(FALLBACK_SESSION_EVENT_TYPES);

for (const specifier of ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session/types"]) {
  try {
    const mod = await import(specifier);
    const found = mod.KNOWN_SESSION_EVENT_TYPES;
    const asSet = found instanceof Set ? found : Array.isArray(found) ? new Set(found) : undefined;
    if (asSet !== undefined && asSet.size > 0) {
      KNOWN_SESSION_EVENT_TYPES.clear();
      for (const type of asSet) KNOWN_SESSION_EVENT_TYPES.add(type);
      eventTypeSource = "installed " + specifier;
      break;
    }
  } catch (e) {
    /* not resolvable from this script's location — keep the snapshot */
  }
}

/** Structural frame walk — mirrors scanZstdFrames (block headers, not magic scan). */
function scanFrames(buf) {
  const frames = [];
  let o = 0;
  while (o < buf.length) {
    const start = o;
    if (buf.length - o < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(o) !== MAGIC) throw new Error(`invalid frame magic at byte ${o}`);
    o += 4;
    if (o === buf.length) return { frames, tornStart: start };
    const descriptor = buf.readUInt8(o);
    o += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${o - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - o < remainingHeaderBytes) return { frames, tornStart: start };
    o += remainingHeaderBytes;
    for (;;) {
      if (buf.length - o < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(o, 3);
      o += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${o - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - o < payloadBytes) return { frames, tornStart: start };
      o += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - o < 4) return { frames, tornStart: start };
      o += 4;
    }
    frames.push({ start, end: o });
  }
  return { frames };
}

/** Audit one log file: returns loadability facts; throws on structural corruption. */
export function auditLog(path) {
  const buf = readFileSync(path);
  const { frames, tornStart } = scanFrames(buf);
  let text = "";
  for (let k = 0; k < frames.length; k++) {
    const { start, end } = frames[k];
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    } catch (e) {
      throw new Error(`frame ${k} at byte ${start} failed validation: ${e.message}`);
    }
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let records = 0;
  const offenders = [];
  let unknownMarked = 0;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { throw new Error("unparsable line"); }
    if (rec.type === "text-chunks" || rec.type === "reasoning-chunks" || rec.type === "tool-call-chunks") continue; // storage row; expands to KNOWN assistant/chunk events
    if (rec.type === "session") continue; // header record; parsed separately by parseHeaderRecord
    if (rec.type === "agent-approval/record") records += 1;
    if (KNOWN_SESSION_EVENT_TYPES.has(rec.type)) continue;
    if (rec.ignorable === true) { unknownMarked += 1; continue; }
    offenders.push({ seq: rec.seq, type: rec.type });
  }
  return { frames: frames.length, tornStart, lines: lines.length, records, offenders, unknownMarked };
}

/** Whether this module is the process entry point (never throws). */
function isMain() {
  try {
    const entry = process.argv[1];
    return typeof entry === "string" && entry !== "" && import.meta.url === pathToFileURL(entry).href;
  } catch (e) {
    return false;
  }
}

if (!isMain()) {
  // imported as a library — no CLI side effects
} else {
  let exitCode = 0;
  let announced = false;
  for (const path of process.argv.slice(2)) {
    if (!announced) {
      announced = true;
      console.log(`event-type vocabulary: ${eventTypeSource}`);
    }
    try {
      const a = auditLog(path);
      const torn = a.tornStart !== undefined ? `, torn final frame at byte ${a.tornStart}` : "";
      console.log(`${path}`);
      console.log(`  frames: ${a.frames}${torn}, lines: ${a.lines}, agent-approval/record events: ${a.records}`);
      if (a.offenders.length > 0) {
        exitCode = 1;
        console.log(`  ✗ WOULD REFUSE TO LOAD — ${a.offenders.length} unknown unmarked event(s): ${a.offenders.slice(0, 10).map((o) => `seq ${o.seq} (${o.type})`).join(", ")}${a.offenders.length > 10 ? ", …" : ""}`);
        console.log(`    fix with: node scripts/repair-session-log.mjs "${path}"`);
      } else {
        console.log(`  ✓ loadable: no unknown unmarked events (unknown-but-ignorable: ${a.unknownMarked})`);
      }
    } catch (e) {
      exitCode = 1;
      console.log(`${path}`);
      console.log(`  ✗ ${e.message}`);
    }
  }
  process.exit(exitCode);
}
