/**
 * Channels module. Registers the host-side handler for the
 * `register_channel` system action emitted by the container MCP tool of
 * the same name (see container/agent-runner/src/mcp-tools/channels.ts).
 */
import { registerDeliveryAction } from '../../delivery.js';
import {
  applyCreateGroup,
  applyGetInviteLink,
  applyLeaveGroup,
  applyListChannels,
  applyListDiscoveredGroups,
  applyRegisterChannel,
  applyRenameGroup,
} from './apply.js';

registerDeliveryAction('register_channel', applyRegisterChannel);
registerDeliveryAction('list_channels', applyListChannels);
registerDeliveryAction('list_discovered_groups', applyListDiscoveredGroups);
registerDeliveryAction('create_group', applyCreateGroup);
registerDeliveryAction('get_invite_link', applyGetInviteLink);
registerDeliveryAction('leave_group', applyLeaveGroup);
registerDeliveryAction('rename_group', applyRenameGroup);
