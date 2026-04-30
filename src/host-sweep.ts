/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, inboundDbPath, outboundDbPath, heartbeatPath } from './session-manager.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
// Stalled-progress detection: container is alive and heartbeating but Claude
// SDK has produced no outbound message in this long despite holding a claim.
// The poll-loop emits the heartbeat — a colgged Claude child won't break it,
// so this rule keys off outbound timestamps instead. Long enough that a real
// long-running Bash (e.g. ImageMagick batch) doesn't trip it.
export const STALLED_PROGRESS_MS = 5 * 60 * 1000;
// After spawning a fresh container, give it this long to boot + run
// clearStaleProcessingAcks() before the SLA check is allowed to kill it.
// Without this, the SLA fires on the same sweep tick as the spawn, sees the
// previous run's orphan claim, and kills the new container before it can
// reach the cleanup code — looping forever.
const SPAWN_GRACE_MS = 30_000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

const lastSpawnAtBySession = new Map<string, number>();

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number }
  | { action: 'kill-stalled'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
  // When undefined, the stalled-progress rule is skipped. Pass 0 to mean
  // "no outbound ever written" (which DOES trip the stalled rule for old
  // claims). Existing callers that don't pass it preserve original
  // ceiling+claim semantics.
  lastOutboundMs?: number;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims, lastOutboundMs } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = Date.parse(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  // Stalled-progress: heartbeat is fresh (poll-loop alive) and we haven't
  // tripped 'kill-claim' because the heartbeat keeps moving past claimedAt,
  // but Claude itself has produced no outbound since the claim. The original
  // heartbeat-vs-claim rule misses this because the heartbeat is written by
  // the poll-loop, which keeps running even when the SDK child is colgged.
  // This rule keys off outbound progress to catch that case. Tolerance is
  // longer (5 min default, expanded by declaredBashMs) so genuine long
  // tool-calls don't false-positive.
  if (lastOutboundMs !== undefined) {
    const stalledTolerance = Math.max(STALLED_PROGRESS_MS, declaredBashMs ?? 0);
    for (const claim of claims) {
      const claimedAt = Date.parse(claim.status_changed);
      if (Number.isNaN(claimedAt)) continue;
      const claimAge = now - claimedAt;
      if (claimAge <= stalledTolerance) continue;
      // Outbound row newer than the claim → the agent IS making progress.
      if (lastOutboundMs > claimedAt) continue;
      return {
        action: 'kill-stalled',
        messageId: claim.message_id,
        claimAgeMs: claimAge,
        toleranceMs: stalledTolerance,
      };
    }
  }

  return { action: 'ok' };
}

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 1b. Pre-wake cleanup: if the container is dead at the top of this tick,
    // run the crashed-container cleanup BEFORE deciding to wake. This handles
    // the respawn-storm case where a container crashes in startup (before
    // clearStaleProcessingAcks() ever runs), because in that path the post-
    // wake "if (!alive)" branch never fires — wake makes alive=true even
    // though the container immediately dies. Without this, tries never
    // increments and the same poisoned message respawns forever every tick.
    if (outDb && !isContainerRunning(session.id)) {
      resetStuckProcessingRows(inDb, outDb, session, agentGroup.id, 'pre-wake');
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      await wakeContainer(session);
      lastSpawnAtBySession.set(session.id, Date.now());
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, agentGroup.id, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  // Grace window after a fresh spawn: the new container needs time to boot
  // and call clearStaleProcessingAcks() before we judge it "stuck". Skipping
  // here lets the next sweep tick assess a container that has actually run.
  const lastSpawn = lastSpawnAtBySession.get(session.id) ?? 0;
  if (Date.now() - lastSpawn < SPAWN_GRACE_MS) return;

  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
    lastOutboundMs: lastOutboundTimestampMs(outDb),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, agentGroupId, 'absolute-ceiling');
    return;
  }

  if (decision.action === 'kill-stalled') {
    // Claude SDK session is corrupted (open tool_use without tool_result).
    // Resuming the same session_id replays the bug, so clear it so the next
    // spawn starts a fresh SDK session. Conversation context lives in
    // /workspace and the per-day archive — not lost.
    log.warn('Killing container — outbound stalled past tolerance', {
      sessionId: session.id,
      messageId: decision.messageId,
      claimAgeMs: decision.claimAgeMs,
      toleranceMs: decision.toleranceMs,
    });
    killContainer(session.id, 'stalled-progress');
    clearSdkSessionId(outDb, agentGroupId, session.id);
    resetStuckProcessingRows(inDb, outDb, session, agentGroupId, 'stalled-progress');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, agentGroupId, 'claim-stuck');
}

function lastOutboundTimestampMs(outDb: Database.Database): number {
  try {
    const row = outDb
      .prepare('SELECT MAX(timestamp) AS t FROM messages_out')
      .get() as { t: string | null } | undefined;
    if (!row?.t) return 0;
    const ms = Date.parse(row.t);
    return Number.isNaN(ms) ? 0 : ms;
  } catch {
    return 0;
  }
}

function clearSdkSessionId(_outDb: Database.Database, agentGroupId: string, sessionId: string): void {
  // outDb is opened readonly to preserve the single-writer invariant; we
  // need a short-lived writable handle for this DELETE. Mirrors the same
  // pattern used in resetStuckProcessingRows. The container is dead by the
  // time this is called (post-kill on stalled-progress), so there is no
  // concurrent writer to race with.
  let writer: Database.Database | null = null;
  try {
    writer = new Database(outboundDbPath(agentGroupId, sessionId));
    writer.prepare("DELETE FROM session_state WHERE key = 'sdk_session_id'").run();
  } catch (err) {
    log.warn('Failed to clear sdk_session_id', { err });
  } finally {
    writer?.close();
  }
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
  reason: string,
): void {
  const claims = getProcessingClaims(outDb);
  const completedCount = (
    outDb
      .prepare("SELECT COUNT(*) as c FROM processing_ack WHERE status IN ('completed', 'failed')")
      .get() as { c: number }
  ).c;

  if (claims.length === 0 && completedCount === 0) return;

  // Open a short-lived writable handle to outbound.db so we can clean orphan
  // processing_ack rows. The shared `outDb` is opened readonly to preserve
  // the single-writer invariant during normal operation, but this function
  // is only called when the container is dead (post-killContainer or in the
  // !alive path) — so there is no concurrent writer to race with. Without
  // this cleanup, a claim whose container crashed before
  // clearStaleProcessingAcks() could run becomes immortal: claim_age grows
  // forever and the SLA loops on it every tick (seen in prod as a 3.6h
  // respawn-storm on session sess-1777082917028-5vohcj).
  const outWriter = new Database(outboundDbPath(agentGroupId, session.id));
  const now = Date.now();
  try {
    const clearClaim = outWriter.prepare('DELETE FROM processing_ack WHERE message_id = ?');

    for (const { message_id } of claims) {
      // Always clear the claim, even if the inDb write below fails. inDb can
      // transiently flip to readonly (lock leak / stale journal), and if that
      // throws before clearClaim, the claim becomes immortal and the SLA
      // loops on it every 60s forever (prod incident 2026-04-29 02:00–02:38:
      // 38 cycles on the same messageId, claimAgeMs growing past 13M ms).
      try {
        const msg = getMessageForRetry(inDb, message_id, 'pending');
        if (!msg) {
          log.info('Cleared orphan processing_ack', { messageId: message_id, sessionId: session.id, reason });
          continue;
        }

        if (msg.processAfter && Date.parse(msg.processAfter) > now) {
          continue;
        }

        if (msg.tries >= MAX_TRIES) {
          markMessageFailed(inDb, msg.id);
          log.warn('Message marked as failed after max retries', {
            messageId: msg.id,
            sessionId: session.id,
            reason,
          });
        } else {
          const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
          const backoffSec = Math.floor(backoffMs / 1000);
          retryWithBackoff(inDb, msg.id, backoffSec);
          log.info('Reset stale message with backoff', {
            messageId: msg.id,
            tries: msg.tries,
            backoffMs,
            reason,
          });
        }
      } catch (err) {
        log.error('inDb write failed during reset — clearing claim anyway to avoid SLA loop', {
          messageId: message_id,
          sessionId: session.id,
          reason,
          err,
        });
      } finally {
        try {
          clearClaim.run(message_id);
        } catch (err) {
          log.error('Failed to clear processing_ack claim', { messageId: message_id, err });
        }
      }
    }

    // Also reap completed/failed rows. syncProcessingAcks() in the sweep loop
    // marks inbound as completed but leaves the outbound row in place because
    // outDb is readonly there. Without this, processing_ack grows unbounded
    // (prod incident: 311 'completed' rows accumulated over 4 days).
    if (completedCount > 0) {
      const reaped = outWriter
        .prepare("DELETE FROM processing_ack WHERE status IN ('completed', 'failed')")
        .run();
      if (reaped.changes > 0) {
        log.info('Reaped completed processing_ack rows', {
          sessionId: session.id,
          count: reaped.changes,
          reason,
        });
      }
    }
  } finally {
    outWriter.close();
  }
}
