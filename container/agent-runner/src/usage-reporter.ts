/**
 * Best-effort token-usage reporter.
 *
 * POSTs one row per completed Claude turn to ghosty-studio's /api/usage,
 * authed via NANOCLAW_ADMIN_TOKEN. Failures are logged and swallowed —
 * never blocks or breaks the user-visible reply path.
 */
import type { TurnUsage } from './providers/types.js';

const DEFAULT_BASE = 'https://ghosty.studio';

function base(): string {
  return (
    process.env.GHOSTY_STUDIO_API_BASE?.trim() ||
    process.env.GHOSTY_BASE_URL?.trim() ||
    DEFAULT_BASE
  );
}

function adminToken(): string | null {
  return process.env.NANOCLAW_ADMIN_TOKEN?.trim() || null;
}

let warnedMissingToken = false;

export interface ReportTurnUsageArgs {
  agentGroupId: string;
  sessionId: string;
  turnIdempotencyKey: string;
  model: string;
  usage: TurnUsage;
  occurredAt: Date;
  userId?: string;
  messagingGroupId?: string;
}

export async function reportTurnUsage(args: ReportTurnUsageArgs): Promise<void> {
  const tk = adminToken();
  if (!tk) {
    if (!warnedMissingToken) {
      console.warn('[usage-reporter] NANOCLAW_ADMIN_TOKEN missing — skipping all usage reports for this run');
      warnedMissingToken = true;
    }
    return;
  }
  const url = `${base()}/api/usage`;
  const body = {
    agent_group_id: args.agentGroupId,
    session_id: args.sessionId,
    turn_idempotency_key: args.turnIdempotencyKey,
    model: args.model,
    input_tokens: args.usage.input_tokens,
    output_tokens: args.usage.output_tokens,
    cache_creation_input_tokens: args.usage.cache_creation_input_tokens,
    cache_read_input_tokens: args.usage.cache_read_input_tokens,
    service_tier: args.usage.service_tier,
    occurred_at: args.occurredAt.toISOString(),
    user_id: args.userId,
    messaging_group_id: args.messagingGroupId,
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tk}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      if (r.status === 401) {
        console.error(`[usage-reporter] token rejected by ghosty (401): ${text.slice(0, 200)}`);
      } else {
        console.warn(`[usage-reporter] ${r.status}: ${text.slice(0, 200)}`);
      }
    }
  } catch (e) {
    console.warn(`[usage-reporter] network: ${e instanceof Error ? e.message : String(e)}`);
  }
}
