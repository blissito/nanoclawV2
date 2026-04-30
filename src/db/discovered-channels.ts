import { getDb } from './index.js';

export interface DiscoveredChannel {
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: 0 | 1;
  first_seen: string;
  last_seen: string;
}

/** Upsert an onMetadata event from a channel adapter. */
export function upsertDiscoveredChannel(
  channel_type: string,
  platform_id: string,
  name: string | null,
  isGroup: boolean,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO discovered_channels (channel_type, platform_id, name, is_group, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_type, platform_id) DO UPDATE SET
         name      = COALESCE(excluded.name, discovered_channels.name),
         is_group  = excluded.is_group,
         last_seen = excluded.last_seen`,
    )
    .run(channel_type, platform_id, name, isGroup ? 1 : 0, now, now);
}

export function listDiscoveredChannels(channelType?: string): DiscoveredChannel[] {
  const db = getDb();
  if (channelType) {
    return db
      .prepare(
        `SELECT * FROM discovered_channels WHERE channel_type = ? ORDER BY last_seen DESC`,
      )
      .all(channelType) as DiscoveredChannel[];
  }
  return db
    .prepare(`SELECT * FROM discovered_channels ORDER BY channel_type, last_seen DESC`)
    .all() as DiscoveredChannel[];
}
