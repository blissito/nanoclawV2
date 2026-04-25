/**
 * Lightweight status tracker — host-side reaction lifecycle on inbound messages.
 *
 * Mirrors v1's status-tracker.ts but trimmed: only tracks "pending" inbound
 * ids per chat. The router calls markPending right after it has reacted 👀
 * to an inbound; delivery.ts calls consumePending after the first chat-kind
 * outbound delivers successfully and reacts ✅ on each id (then forgets them).
 *
 * No persistence, no retries, no terminal states. Restart loses pending; the
 * 👀 stays on the user's message but no ✅ — acceptable trade-off for now.
 */

const pendingByChatJid = new Map<string, Set<string>>();

export function markPending(chatJid: string, messageId: string): void {
  let set = pendingByChatJid.get(chatJid);
  if (!set) {
    set = new Set();
    pendingByChatJid.set(chatJid, set);
  }
  set.add(messageId);
}

/**
 * Drain all pending ids for a chat and return them. Caller is responsible
 * for reacting ✅ on each. Returns [] if nothing pending.
 */
export function consumePending(chatJid: string): string[] {
  const set = pendingByChatJid.get(chatJid);
  if (!set || set.size === 0) return [];
  const ids = Array.from(set);
  pendingByChatJid.delete(chatJid);
  return ids;
}
