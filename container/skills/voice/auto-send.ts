#!/usr/bin/env bun
/**
 * auto-send: queue a generated file for delivery without requiring the agent
 * to call mcp__nanoclaw__send_file. Used by skills like text-to-speech that
 * produce a file and should immediately deliver it on the user's behalf —
 * the agent ignoring the "call send_file" instruction was a recurring bug.
 *
 * Writes a row to messages_out and copies the file into outbox/, mimicking
 * what the send_file MCP tool does but driven by the skill itself.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const filePath = process.argv[2];
if (!filePath || !existsSync(filePath)) {
  console.error(`auto-send: file not found: ${filePath}`);
  process.exit(1);
}

const inbound = new Database('/workspace/inbound.db');
const outbound = new Database('/workspace/outbound.db');

const routing = inbound
  .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
  .get() as { channel_type: string; platform_id: string; thread_id: string | null } | undefined;

if (!routing || !routing.platform_id || !routing.channel_type) {
  console.error('auto-send: no session_routing — agent must call send_file manually');
  process.exit(1);
}

const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
const max = Math.max(maxOut, maxIn);
const nextSeq = max % 2 === 0 ? max + 1 : max + 2;

const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const filename = basename(filePath);
const outboxDir = `/workspace/outbox/${id}`;
mkdirSync(outboxDir, { recursive: true });
copyFileSync(filePath, join(outboxDir, filename));

outbound
  .prepare(
    `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES ($id, $seq, datetime('now'), $kind, $platform_id, $channel_type, $thread_id, $content)`,
  )
  .run({
    $id: id,
    $seq: nextSeq,
    $kind: 'chat',
    $platform_id: routing.platform_id,
    $channel_type: routing.channel_type,
    $thread_id: routing.thread_id,
    $content: JSON.stringify({ text: '', files: [filename] }),
  });

console.error(`auto-send: queued #${nextSeq} (${filename})`);
