/**
 * Approval handlers for self-modification actions.
 *
 * The approvals module calls these when an admin clicks Approve on a
 * pending_approvals row whose action matches. Each handler mutates the
 * container config, rebuilds/kills the container as needed, and lets the
 * host sweep respawn it on the new image on the next message.
 *
 * install_packages: rebuild image + kill container (apt/npm global installs
 *   must be baked into the image layer).
 * add_mcp_server: kill container only — bun runs TS directly, so a pure
 *   MCP wiring change needs nothing more than a process restart.
 *
 * restart_container: direct delivery action (no approval). Kills every
 *   session container of a target agent group; sweep respawns on next
 *   inbound message. Gated by canAccessAgentGroup for owner / global_admin
 *   / admin_of_group on the TARGET group. Defaults target to caller's own
 *   agent group when content.agent_group_id is null.
 */
import type Database from 'better-sqlite3';

import { updateContainerConfig } from '../../container-config.js';
import { buildAgentGroupImage, killContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import type { ApprovalHandler } from '../approvals/index.js';
import { canAccessAgentGroup } from '../permissions/access.js';

export const applyInstallPackages: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_packages approved but agent group missing.');
    return;
  }
  updateContainerConfig(agentGroup.folder, (cfg) => {
    if (payload.apt) cfg.packages.apt.push(...(payload.apt as string[]));
    if (payload.npm) cfg.packages.npm.push(...(payload.npm as string[]));
  });

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id, userId });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    killContainer(session.id, 'rebuild applied');
    // Schedule a follow-up prompt a few seconds after kill so the host sweep
    // respawns the container on the new image and the agent verifies + reports.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
        sender: 'system',
        senderId: 'system',
      }),
      processAfter: new Date(Date.now() + 5000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ''),
    });
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    notify(
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
};

function getLastInboundUserId(inDb: Database.Database): string | null {
  try {
    const rows = inDb
      .prepare(
        `SELECT content, channel_type FROM messages_in
         WHERE kind = 'chat' AND trigger = 1
           AND channel_type IS NOT NULL AND channel_type != 'agent'
         ORDER BY seq DESC
         LIMIT 5`,
      )
      .all() as Array<{ content: string; channel_type: string }>;
    for (const row of rows) {
      let parsed: { sender?: string; senderId?: string };
      try {
        parsed = JSON.parse(row.content);
      } catch {
        continue;
      }
      const raw = parsed.senderId ?? parsed.sender;
      if (!raw || raw === 'system') continue;
      return raw.includes(':') ? raw : `${row.channel_type}:${raw}`;
    }
    return null;
  } catch {
    return null;
  }
}

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-restart-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    processAfter: new Date(Date.now() + 1500)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ''),
  });
}

export async function applyRestartContainer(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const targetAgentGroupId = (content.agent_group_id as string | undefined) || session.agent_group_id;
  const reason = (content.reason as string | undefined) || 'agent-requested restart';

  const userId = getLastInboundUserId(inDb);
  if (!userId) {
    notifyAgent(session, 'restart_container rejected: could not resolve the calling user from the current session.');
    return;
  }

  const access = canAccessAgentGroup(userId, targetAgentGroupId);
  const privileged =
    access.allowed && ['owner', 'global_admin', 'admin_of_group'].includes(access.reason);
  if (!privileged) {
    notifyAgent(
      session,
      `restart_container rejected: requires owner or admin privileges on agent group "${targetAgentGroupId}". Current role for ${userId}: ${access.allowed ? access.reason : access.reason ?? 'none'}.`,
    );
    return;
  }

  const targetGroup = getAgentGroup(targetAgentGroupId);
  if (!targetGroup) {
    notifyAgent(session, `restart_container rejected: agent group "${targetAgentGroupId}" not found.`);
    return;
  }

  const sessions = getSessionsByAgentGroup(targetAgentGroupId);
  const isSelf = targetAgentGroupId === session.agent_group_id;

  // Notify BEFORE killing self so the message lands in inbound.db while the
  // container is still alive to respawn and read it. Self-kill: caller reads
  // the note when next user message wakes it. Cross-group: caller stays alive
  // and reports the count back.
  if (isSelf) {
    notifyAgent(
      session,
      `Restarting your own container (reason: ${reason}). The next inbound message will respawn you. Read this and report to the user when you wake up.`,
    );
  } else {
    notifyAgent(
      session,
      `Killed ${sessions.length} session container(s) of agent group "${targetGroup.name}" (id ${targetAgentGroupId}, reason: ${reason}). They will respawn on their next inbound message. Report to the user.`,
    );
  }

  let killed = 0;
  for (const s of sessions) {
    try {
      killContainer(s.id, `restart_container: ${reason}`);
      killed++;
    } catch (e) {
      log.warn('restart_container: kill failed for session', {
        sessionId: s.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  log.info('restart_container applied', {
    targetAgentGroupId,
    requestedBy: userId,
    reason,
    sessionsKilled: killed,
    self: isSelf,
  });
}

export const applyAddMcpServer: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('add_mcp_server approved but agent group missing.');
    return;
  }
  updateContainerConfig(agentGroup.folder, (cfg) => {
    cfg.mcpServers[payload.name as string] = {
      command: payload.command as string,
      args: (payload.args as string[]) || [],
      env: (payload.env as Record<string, string>) || {},
    };
  });

  killContainer(session.id, 'mcp server added');
  notify(`MCP server "${payload.name}" added. Your container will restart with it on the next message.`);
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id, userId });
};
