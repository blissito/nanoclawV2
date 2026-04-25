/**
 * Discovered channels: cache of chats/groups/DMs that an adapter has seen
 * (via `onMetadata` — Baileys group sync for WhatsApp, etc.) but that are
 * not necessarily wired to an agent yet.
 *
 * Used by the `list_discovered_groups` MCP tool so the agent can resolve a
 * group name → platform_id and then call `register_channel` without the
 * user having to paste a raw JID.
 *
 * Row lifecycle: upsert on every `onMetadata` event. Never auto-deleted —
 * stale rows are a minor concern (groups you left still show up) but not
 * worth the extra machinery; add an explicit cleanup later if needed.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'discovered-channels',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discovered_channels (
        channel_type   TEXT NOT NULL,
        platform_id    TEXT NOT NULL,
        name           TEXT,
        is_group       INTEGER NOT NULL DEFAULT 0,
        first_seen     TEXT NOT NULL,
        last_seen      TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id)
      );
      CREATE INDEX IF NOT EXISTS idx_discovered_channels_type
        ON discovered_channels(channel_type);
    `);
  },
};
