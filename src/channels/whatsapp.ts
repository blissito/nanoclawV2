/**
 * WhatsApp channel adapter (v2) — native Baileys v6 implementation.
 *
 * Implements ChannelAdapter directly (no Chat SDK bridge) using
 * @whiskeysockets/baileys v6 (stable). Ports proven v1 infrastructure:
 * getMessage fallback, outgoing queue, group metadata cache, LID mapping,
 * reconnection with backoff.
 *
 * Auth credentials persist in store/auth/. On first run:
 * - If WHATSAPP_PHONE_NUMBER is set → pairing code (printed to log)
 * - Otherwise → QR code (printed to log)
 * Subsequent restarts reuse the saved session automatically.
 */
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Named import (not default) — pino's .d.ts under NodeNext resolution
// exports `{ pino as default, pino }`, but the namespace/function merge at
// `declare namespace pino` + `declare function pino` makes the default
// resolve to `typeof pino` (the namespace type), which isn't callable.
// The named export resolves to the callable function.
import { pino } from 'pino';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { GroupMetadata, WAMessageKey, WAMessage, WASocket } from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { getDb } from '../db/connection.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';

// Baileys v6 bug: getPlatformId sends charCode (49) instead of enum value (1).
// Fixed in Baileys 7.x but not backported. Without this, pairing codes fail with
// "couldn't link device" because WhatsApp receives an invalid platform ID.
// Must use createRequire — ESM `import *` creates a read-only namespace.
// proto is not available as a named ESM export — use createRequire (same as v1)
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { proto } = _require('@whiskeysockets/baileys') as { proto: any };
try {
  const _generics = _require('@whiskeysockets/baileys/lib/Utils/generics') as Record<string, unknown>;
  _generics.getPlatformId = (browser: string): string => {
    const platformType =
      proto.DeviceProps.PlatformType[browser.toUpperCase() as keyof typeof proto.DeviceProps.PlatformType];
    return platformType ? platformType.toString() : '1';
  };
} catch {
  // CJS require failed (Node version mismatch): pairing-code auth path is
  // unavailable, QR auth still works. Demoted to info — most installs never
  // use pairing codes, so this is not actionable.
  log.info('getPlatformId patch skipped (pairing-code auth unavailable, QR works)');
}

const baileysLogger = pino({ level: 'silent' });

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const GROUP_METADATA_CACHE_TTL_MS = 60_000; // 1 min for outbound sends
const SENT_MESSAGE_CACHE_MAX = 256;
// Cap on participant IDs included in an inbound metadata payload. Beyond
// this we send count + a "truncated" flag so the prompt doesn't bloat for
// 500+ member groups.
const PARTICIPANTS_INBOUND_CAP = 50;
const RECONNECT_DELAY_MS = 5000;
const PENDING_QUESTIONS_MAX = 64;

/** Normalize an option label to a slash command: "Approve" → "/approve" */
function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

// --- Markdown → WhatsApp formatting ---

interface TextSegment {
  content: string;
  isProtected: boolean;
}

/** Split text into code-block-protected and unprotected regions. */
function splitProtectedRegions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ content: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isProtected: false });
  }

  return segments;
}

/** Apply WhatsApp-native formatting to an unprotected text segment. */
function transformForWhatsApp(text: string): string {
  // Order matters: italic before bold to avoid **bold** → *bold* → _bold_
  // 1. Italic: *text* (not **) → _text_
  text = text.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');
  // 2. Bold: **text** → *text*
  text = text.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  // 3. Headings: ## Title → *Title*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // 4. Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 5. Horizontal rules: --- / *** / ___ → stripped
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
  return text;
}

/** Convert Claude's markdown to WhatsApp-native formatting. */
function formatWhatsApp(text: string): string {
  const segments = splitProtectedRegions(text);
  return segments.map(({ content, isProtected }) => (isProtected ? content : transformForWhatsApp(content))).join('');
}

/**
 * Parse @<digits> mentions out of an outbound text. Returns the JIDs that
 * Baileys needs in the `mentions` array so WhatsApp renders them as tags
 * and notifies the receivers. Text is left as-is — WhatsApp's UI uses the
 * literal `@<digits>` in the body to know where to highlight.
 *
 * Phone JID range: 8-15 digits covers all valid country codes. Excludes
 * email addresses (no `@` after digit-letter mix) and accidental matches
 * like prices `@5`.
 *
 * `@all` / `@todos` (case-insensitive, word-boundary) is a separate path
 * handled in `expandAllMentions` because it requires the caller to know
 * the group's full participant list. We strip it from the result here so
 * callers can tell whether the broadcast token was present.
 */
export function parseMentions(text: string): {
  mentions: string[];
  hasAll: boolean;
} {
  // `(?!\d)` anchor prevents partial matches inside longer digit runs —
  // `@1234567890123456` (16 digits) shouldn't pick up the first 15 as a
  // bogus JID. Anything that's not a digit (space, comma, end-of-string,
  // letters) is a valid trailing context.
  const matches = text.matchAll(/@(\d{8,15})(?!\d)/g);
  const mentions = [...new Set([...matches].map((m) => `${m[1]}@s.whatsapp.net`))];
  // Unicode-safe boundary: `\b` in JS regex treats `á`/`ñ`/etc. as
  // non-word, which would make `@allá` and `@todosá` match. Negative
  // lookahead with `\p{L}\p{N}` (Unicode letter / number) properly
  // excludes any letter from any script.
  const hasAll = /@(?:all|todos)(?![\p{L}\p{N}_])/iu.test(text);
  return { mentions, hasAll };
}

/**
 * Resolve `@all` to the list of every participant JID in a group. Caller
 * passes in the cached participant list (or null when the cache is empty
 * / the group can't be looked up). When `hasAll` is true but participants
 * is null, we just notify the digit-mentions that were already parsed —
 * better than blocking the message on a metadata fetch.
 */
export function expandAllMentions(args: {
  parsed: { mentions: string[]; hasAll: boolean };
  participants: string[] | null;
}): string[] {
  const { parsed, participants } = args;
  if (!parsed.hasAll || !participants || participants.length === 0) {
    return parsed.mentions;
  }
  return [...new Set([...parsed.mentions, ...participants])];
}

/**
 * Parse `@<word>` name-style mentions out of an outbound text — the LLM
 * writes "@Bliss" but Baileys only renders mentions when literal `@<digits>`
 * appears in the body. We extract candidate names so the resolver can look
 * them up in the v2 users table and rewrite to phone numbers.
 *
 * Filters out: `@<digits>` (handled by parseMentions), `@all`/`@todos`
 * (handled by expandAllMentions). Letter-leading + 2+30 chars covers
 * typical first names without dragging in noise like "@5" or "@hi".
 */
export function parseNameMentions(text: string): string[] {
  const matches = [...text.matchAll(/@([\p{L}][\p{L}\p{N}_-]{1,30})/giu)];
  const candidates = matches
    .map((m) => m[1])
    .filter((n) => !/^(all|todos)$/i.test(n))
    .filter((n) => !/^\d+$/.test(n));
  return [...new Set(candidates)];
}

/**
 * Look up users in the central DB by display_name (case-insensitive
 * substring match). Returns user.id (channel-prefixed JID, e.g.
 * `whatsapp:5217712412825@s.whatsapp.net`) and display_name. Caller
 * is responsible for stripping the prefix and intersecting with the
 * group's participant list before sending mentions.
 */
function findUsersByName(names: string[]): Array<{ id: string; display_name: string | null }> {
  if (names.length === 0) return [];
  const placeholders = names.map(() => 'LOWER(display_name) LIKE ?').join(' OR ');
  return getDb()
    .prepare(`SELECT id, display_name FROM users WHERE display_name IS NOT NULL AND (${placeholders})`)
    .all(...names.map((n) => `%${n.toLowerCase()}%`)) as Array<{ id: string; display_name: string | null }>;
}

/** Map file extension to Baileys media message type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMediaMessage(data: Buffer, filename: string, ext: string, caption?: string): any {
  // .webp gets sent as a native sticker, not as an image attachment. WhatsApp
  // renders sticker messages with no border, in-line, and supports animated
  // sticker frames. The agent generates .webp specifically for this rendering;
  // sending as image with `mimetype: 'image/webp'` shows it as a generic image
  // with a download button, which defeats the purpose. Stickers don't carry
  // captions — if caption was passed it'll be sent separately by the caller.
  if (ext === '.webp') {
    return { sticker: data };
  }

  const imageExts = ['.jpg', '.jpeg', '.png', '.gif'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv'];
  const audioExts = ['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus'];

  if (imageExts.includes(ext)) {
    return { image: data, caption, mimetype: `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}` };
  }
  if (videoExts.includes(ext)) {
    return { video: data, caption, mimetype: `video/${ext.slice(1)}` };
  }
  if (audioExts.includes(ext)) {
    // ogg/opus → voice note (push-to-talk). The full mimetype with the
    // codec parameter is load-bearing: WhatsApp shows "Waiting for this
    // message" indefinitely if it receives plain `audio/ogg` without the
    // `codecs=opus` hint. This matches v1's sendAudio exactly.
    const isVoiceNote = ext === '.ogg' || ext === '.opus';
    const mimetype = isVoiceNote
      ? 'audio/ogg; codecs=opus'
      : `audio/${ext.slice(1) === 'mp3' ? 'mpeg' : ext.slice(1)}`;
    return { audio: data, mimetype, ptt: isVoiceNote };
  }
  // Default: send as document
  return { document: data, fileName: filename, caption, mimetype: 'application/octet-stream' };
}

registerChannelAdapter('whatsapp', {
  factory: () => {
    const env = readEnvFile(['WHATSAPP_PHONE_NUMBER', 'WHATSAPP_ENABLED']);
    const phoneNumber = env.WHATSAPP_PHONE_NUMBER;
    const authDir = AUTH_DIR;

    // Skip if no existing auth, no phone number for pairing, and not explicitly enabled (QR mode)
    const hasAuth = fs.existsSync(path.join(authDir, 'creds.json'));
    if (!hasAuth && !phoneNumber && !env.WHATSAPP_ENABLED) return null;

    fs.mkdirSync(authDir, { recursive: true });

    // State
    let sock: WASocket;
    let connected = false;
    let setupConfig: ChannelSetup;

    // LID → phone JID mapping (WhatsApp's new ID system)
    const lidToPhoneMap: Record<string, string> = {};
    let botLidUser: string | undefined;

    // Outgoing queue for messages sent while disconnected
    const outgoingQueue: Array<{ jid: string; text: string }> = [];
    let flushing = false;

    // Sent message cache for retry/re-encrypt requests
    const sentMessageCache = new Map<string, any>();
    // Cache of inbound WAMessageKey indexed by msg.key.id, kept so the host
    // can react to a user's message in a group — Baileys needs `participant`
    // in the reaction key, which only the original key carries.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inboundKeyCache = new Map<string, any>();
    const INBOUND_KEY_CACHE_MAX = 500;

    // Group metadata cache with TTL
    const groupMetadataCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();

    // Pending questions: chatJid → { questionId, options }
    // User replies with /approve, /reject, etc. to answer
    const pendingQuestions = new Map<
      string,
      {
        questionId: string;
        options: NormalizedOption[];
      }
    >();

    // Group sync tracking
    let lastGroupSync = 0;
    let groupSyncTimerStarted = false;

    // First-connect promise
    let resolveFirstOpen: (() => void) | undefined;
    let rejectFirstOpen: ((err: Error) => void) | undefined;

    // Pairing code file for the setup skill to poll
    const pairingCodeFile = path.join(process.cwd(), 'store', 'pairing-code.txt');

    // --- Helpers ---

    function setLidPhoneMapping(lidUser: string, phoneJid: string): void {
      if (lidToPhoneMap[lidUser] === phoneJid) return;
      lidToPhoneMap[lidUser] = phoneJid;
      // Cached group metadata depends on participant IDs — invalidate
      groupMetadataCache.clear();
    }

    async function translateJid(jid: string): Promise<string> {
      if (!jid.endsWith('@lid')) return jid;
      const lidUser = jid.split('@')[0].split(':')[0];

      const cached = lidToPhoneMap[lidUser];
      if (cached) return cached;

      // Query Baileys' signal repository
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pn = await (sock.signalRepository as any)?.lidMapping?.getPNForLID(jid);
        if (pn) {
          const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
          setLidPhoneMapping(lidUser, phoneJid);
          log.info('Translated LID to phone JID', { lidJid: jid, phoneJid });
          return phoneJid;
        }
      } catch (err) {
        log.debug('Failed to resolve LID via signalRepository', { jid, err });
      }

      return jid;
    }

    async function getNormalizedGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
      if (!jid.endsWith('@g.us')) return undefined;

      const cached = groupMetadataCache.get(jid);
      if (cached && cached.expiresAt > Date.now()) return cached.metadata;

      // IMPORTANT: return participant IDs untouched (incl. `@lid`).
      // Baileys uses this list for group send fan-out — it looks up Signal
      // sessions and device lists keyed by JID. Modern WA groups key those
      // by `@lid`; translating to phone JID here causes per-participant
      // encryption to fail silently and the message only reaches our own
      // linked devices ("solo yo lo veo" piggyback bug). Sender-side
      // identity translation happens elsewhere (translateJid on inbound).
      const metadata = await sock.groupMetadata(jid);
      groupMetadataCache.set(jid, {
        metadata,
        expiresAt: Date.now() + GROUP_METADATA_CACHE_TTL_MS,
      });
      return metadata;
    }

    /**
     * Return the list of participant JIDs for a group, or null if it's not a
     * group / we can't fetch metadata. Reuses `getNormalizedGroupMetadata`'s
     * cache (TTL-based) so we don't burn an API call on every inbound. JIDs
     * are returned raw — `@s.whatsapp.net` for phone, `@lid` for hidden IDs;
     * caller decides what to do (the inbound metadata path keeps both, the
     * `@all` outbound expansion uses the raw JIDs which is what Baileys'
     * `mentions` field expects).
     */
    async function getParticipantsList(jid: string): Promise<string[] | null> {
      try {
        const metadata = await getNormalizedGroupMetadata(jid);
        if (!metadata) return null;
        return metadata.participants.map((p) => p.id);
      } catch (err) {
        log.warn('Failed to load group participants', { jid, err });
        return null;
      }
    }

    async function syncGroupMetadata(force = false): Promise<void> {
      if (!force && lastGroupSync && Date.now() - lastGroupSync < GROUP_SYNC_INTERVAL_MS) {
        return;
      }
      try {
        log.info('Syncing group metadata from WhatsApp...');
        const groups = await sock.groupFetchAllParticipating();
        let count = 0;
        for (const [jid, metadata] of Object.entries(groups)) {
          if (metadata.subject) {
            setupConfig.onMetadata(jid, metadata.subject, true);
            count++;
          }
        }
        lastGroupSync = Date.now();
        log.info('Group metadata synced', { count });
      } catch (err) {
        log.error('Failed to sync group metadata', { err });
      }
    }

    async function flushOutgoingQueue(): Promise<void> {
      if (flushing || outgoingQueue.length === 0) return;
      flushing = true;
      try {
        log.info('Flushing outgoing message queue', { count: outgoingQueue.length });
        while (outgoingQueue.length > 0) {
          const item = outgoingQueue.shift()!;
          const sent = await sock.sendMessage(item.jid, { text: item.text });
          if (sent?.key?.id && sent.message) {
            sentMessageCache.set(sent.key.id, sent.message);
          }
        }
      } finally {
        flushing = false;
      }
    }

    /**
     * Local-only voice-note transcription via whisper.cpp.
     *   - Requires WHISPER_BIN and WHISPER_MODEL env vars; if either is missing
     *     or the model file doesn't exist, returns null and caller falls back
     *     to a `[Voice Message]` placeholder.
     *   - No paid OpenAI fallback by design — operator decision to keep this free.
     *
     * WhatsApp voice notes are OGG/Opus; whisper-cpp wants 16kHz mono WAV.
     * ffmpeg handles the conversion (autodetects input codec). All temp
     * files are written to os.tmpdir() and cleaned up in finally.
     *
     * Pattern ported from v1 src/transcription.ts.
     */
    async function transcribeAudioOptional(filePath: string): Promise<string | null> {
      // systemd unit doesn't load .env, so process.env.WHISPER_BIN is undefined
      // even when the var is in /opt/nanoclaw-v2/.env. Read it directly.
      const env = readEnvFile(['WHISPER_BIN', 'WHISPER_MODEL', 'WHISPER_LANG']);
      const whisperBin = env.WHISPER_BIN || process.env.WHISPER_BIN;
      const model = env.WHISPER_MODEL || process.env.WHISPER_MODEL;
      log.info('WhatsApp: transcribe attempt', { hasBin: !!whisperBin, hasModel: !!model });
      if (!whisperBin || !model || !fs.existsSync(model)) {
        log.warn('WhatsApp: whisper not configured', { whisperBin, model });
        return null;
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const wavPath = path.join(os.tmpdir(), `wa-voice-${id}.wav`);

      try {
        await execFileAsync('ffmpeg', ['-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath, '-y'], {
          timeout: 30000,
        });
        // -l es: force Spanish language detection. Without it, whisper.cpp
        // defaults to English and returns "(speaking in foreign language)"
        // for Spanish audio. WHISPER_LANG env var can override.
        const lang = env.WHISPER_LANG || process.env.WHISPER_LANG || 'es';
        const { stdout } = await execFileAsync(
          whisperBin,
          ['-m', model, '-f', wavPath, '-l', lang, '--no-timestamps', '-nt'],
          { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
        );
        const text = stdout.replace(/\[[^\]]*\]/g, '').trim();
        return text || null;
      } catch (err) {
        log.warn('WhatsApp: whisper transcription failed', { err });
        return null;
      } finally {
        try {
          fs.unlinkSync(wavPath);
        } catch {}
      }
    }

    /** Download media from an inbound message, save to /workspace/attachments/. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function downloadInboundMedia(
      msg: WAMessage,
      normalized: any,
    ): Promise<Array<{ type: string; name: string; localPath: string }>> {
      const mediaTypes: Array<{ key: string; type: string; ext: string }> = [
        { key: 'imageMessage', type: 'image', ext: '.jpg' },
        { key: 'videoMessage', type: 'video', ext: '.mp4' },
        { key: 'audioMessage', type: 'audio', ext: '.ogg' },
        { key: 'documentMessage', type: 'document', ext: '' },
      ];
      const results: Array<{ type: string; name: string; localPath: string }> = [];
      for (const { key, type, ext } of mediaTypes) {
        if (!normalized[key]) continue;
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const docFilename = normalized[key].fileName;
          const filename = docFilename || `${type}-${Date.now()}${ext}`;
          const attachDir = path.join(DATA_DIR, 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });
          const filePath = path.join(attachDir, filename);
          fs.writeFileSync(filePath, buffer);
          results.push({ type, name: filename, localPath: `attachments/${filename}` });
          log.info('Media downloaded', { type, filename });
        } catch (err) {
          log.warn('Failed to download media', { type, err });
        }
      }
      return results;
    }

    /**
     * When the user replies citing a previous message (Baileys puts it under
     * `extendedTextMessage.contextInfo.quotedMessage`), build a synthetic
     * WAMessage envelope so `downloadMediaMessage` can fetch the cited file
     * and append it to the inbound attachments. Returns null when there is
     * no quoted media or no quote at all.
     *
     * The synthetic envelope must use the original quoted message's stanzaId
     * + participant from `contextInfo` — Baileys uses these to reconstruct
     * the encrypted media keys. Without them the download throws.
     */
    async function processQuotedMessage(
      msg: WAMessage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      normalized: any,
    ): Promise<{
      prefix: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      quotedAttachments: Array<{ type: string; name: string; localPath: string }>;
    } | null> {
      const ctx = normalized.extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage;
      if (!quoted) return null;

      const quotedText =
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        quoted.imageMessage?.caption ||
        quoted.videoMessage?.caption ||
        quoted.documentMessage?.fileName ||
        (quoted.audioMessage ? '<voice note>' : '') ||
        (quoted.stickerMessage ? '<sticker>' : '') ||
        '<media>';

      const prefix = `[Replying to: "${quotedText.slice(0, 200)}"]`;

      // Try to re-download the cited media. If contextInfo lacks the
      // identifying fields, downloadMediaMessage will fail; we swallow that
      // and just return the text prefix so the agent at least sees the cite.
      let quotedAttachments: Array<{ type: string; name: string; localPath: string }> = [];
      const hasMedia =
        quoted.imageMessage ||
        quoted.videoMessage ||
        quoted.audioMessage ||
        quoted.documentMessage;
      if (hasMedia && ctx.stanzaId) {
        const syntheticMsg: WAMessage = {
          key: {
            remoteJid: msg.key.remoteJid,
            id: ctx.stanzaId,
            fromMe: false,
            participant: ctx.participant,
          },
          message: quoted,
        };
        try {
          quotedAttachments = await downloadInboundMedia(syntheticMsg, quoted);
        } catch (err) {
          log.warn('Failed to download quoted media', { err });
        }
      }

      return { prefix, quotedAttachments };
    }

    /**
     * Compute the `mentions` array for an outbound text. Lazy-fetches
     * group participants only when `@all`/`@todos` is present (the common
     * `@<digits>` case doesn't need a metadata round-trip). For DMs we skip
     * even the `@all` expansion — there's no one else to broadcast to.
     */
    async function resolveMentionsForText(
      platformId: string,
      text: string,
    ): Promise<string[]> {
      const parsed = parseMentions(text);
      if (!parsed.hasAll || !platformId.endsWith('@g.us')) {
        return parsed.mentions;
      }
      const participants = await getParticipantsList(platformId);
      return expandAllMentions({ parsed, participants });
    }

    /**
     * Resolve `@Name` (text-name) mentions and rewrite them to `@<phone>`
     * so Baileys actually highlights the tag and notifies the receiver.
     * Combines with the existing digit + `@all`/`@todos` resolution.
     *
     * Returns `{text, mentions}` because Baileys only renders a mention
     * when the literal `@<digits>` substring appears in the body matching
     * a JID in the mentions array — we cannot just add JIDs without
     * rewriting the visible text. Lookup keys off the central `users`
     * table (display_name) and intersects with the group's current
     * participant list so we never @-tag someone who isn't in this chat.
     */
    async function resolveMentionsAndRewrite(
      platformId: string,
      text: string,
    ): Promise<{ text: string; mentions: string[] }> {
      const baseMentions = await resolveMentionsForText(platformId, text);
      if (!platformId.endsWith('@g.us')) return { text, mentions: baseMentions };

      const candidateNames = parseNameMentions(text);
      if (candidateNames.length === 0) return { text, mentions: baseMentions };

      const users = findUsersByName(candidateNames);
      if (users.length === 0) return { text, mentions: baseMentions };

      const participants = await getParticipantsList(platformId);
      if (!participants || participants.length === 0) return { text, mentions: baseMentions };
      const participantSet = new Set(participants);

      const stripPrefix = (id: string): string => (id.startsWith('whatsapp:') ? id.slice('whatsapp:'.length) : id);

      let outText = text;
      const finalMentions = new Set(baseMentions);
      for (const name of candidateNames) {
        const lname = name.toLowerCase();
        const match = users.find((u) => {
          if (!u.display_name?.toLowerCase().includes(lname)) return false;
          return participantSet.has(stripPrefix(u.id));
        });
        if (!match) continue;
        const phoneJid = stripPrefix(match.id);
        const phoneNumber = phoneJid.split('@')[0];
        // Rewrite ALL occurrences of @Name (case-insensitive, word-bound by
        // the regex's character class). Use a fresh regex per name so global
        // state doesn't leak across iterations.
        outText = outText.replace(new RegExp(`@${name}(?=$|[^\\p{L}\\p{N}_])`, 'giu'), `@${phoneNumber}`);
        finalMentions.add(phoneJid);
      }
      return { text: outText, mentions: [...finalMentions] };
    }

    async function sendRawMessage(
      jid: string,
      text: string,
      mentions?: string[],
    ): Promise<string | undefined> {
      if (!connected) {
        // Mentions are dropped on requeue — the queue is a string-text fallback
        // for offline catch-up. Re-enqueueing as plain text loses the tag but
        // delivers the content; better than failing the send.
        outgoingQueue.push({ jid, text });
        log.info('WA disconnected, message queued', { jid, queueSize: outgoingQueue.length });
        return;
      }
      try {
        const payload = mentions && mentions.length > 0
          ? { text, mentions }
          : { text };
        const sent = await sock.sendMessage(jid, payload);
        if (sent?.key?.id && sent.message) {
          sentMessageCache.set(sent.key.id, sent.message);
          if (sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
            const oldest = sentMessageCache.keys().next().value!;
            sentMessageCache.delete(oldest);
          }
        }
        return sent?.key?.id ?? undefined;
      } catch (err) {
        outgoingQueue.push({ jid, text });
        log.warn('Failed to send, message queued', { jid, err, queueSize: outgoingQueue.length });
        return undefined;
      }
    }

    // --- Socket creation ---

    async function connectSocket(): Promise<void> {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
        log.warn('Failed to fetch latest WA Web version, using default', { err });
        return { version: undefined };
      });

      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
        cachedGroupMetadata: async (jid: string) => getNormalizedGroupMetadata(jid),
        getMessage: async (key: WAMessageKey) => {
          // Check in-memory cache first (recently sent messages)
          const cached = sentMessageCache.get(key.id || '');
          if (cached) return cached;
          // Return empty message to prevent indefinite "waiting for this message"
          return proto.Message.fromObject({});
        },
      });

      // Request pairing code if phone number is set and not yet registered
      if (phoneNumber && !state.creds.registered) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            log.info(`WhatsApp pairing code: ${code}`);
            log.info('Enter in WhatsApp > Linked Devices > Link with phone number');
            fs.writeFileSync(pairingCodeFile, code, 'utf-8');
          } catch (err) {
            log.error('Failed to request pairing code', { err });
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !phoneNumber) {
          // QR code auth — print to terminal
          (async () => {
            try {
              const QRCode = await import('qrcode');
              const qrText = await QRCode.toString(qr, { type: 'terminal' });
              log.info('WhatsApp QR code — scan with WhatsApp > Linked Devices:\n' + qrText);
            } catch {
              log.info('WhatsApp QR code (raw)', { qr });
            }
          })();
        }

        if (connection === 'close') {
          connected = false;
          const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const shouldReconnect = reason !== DisconnectReason.loggedOut;

          log.info('WhatsApp connection closed', { reason, shouldReconnect });

          if (shouldReconnect) {
            log.info('Reconnecting...');
            connectSocket().catch((err) => {
              log.error('Failed to reconnect, retrying in 5s', { err });
              setTimeout(() => {
                connectSocket().catch((err2) => {
                  log.error('Reconnection retry failed', { err: err2 });
                });
              }, RECONNECT_DELAY_MS);
            });
          } else {
            log.info('WhatsApp logged out');
            if (rejectFirstOpen) {
              rejectFirstOpen(new Error('WhatsApp logged out'));
              rejectFirstOpen = undefined;
              resolveFirstOpen = undefined;
            }
          }
        } else if (connection === 'open') {
          connected = true;
          log.info('Connected to WhatsApp');

          // Clean up pairing code file after successful connection
          try {
            if (fs.existsSync(pairingCodeFile)) fs.unlinkSync(pairingCodeFile);
          } catch {
            /* ignore */
          }

          // Announce availability for presence updates
          sock.sendPresenceUpdate('available').catch((err) => {
            log.warn('Failed to send presence update', { err });
          });

          // Build LID → phone mapping from auth state
          if (sock.user) {
            const phoneUser = sock.user.id.split(':')[0];
            const lidUser = sock.user.lid?.split(':')[0];
            if (lidUser && phoneUser) {
              setLidPhoneMapping(lidUser, `${phoneUser}@s.whatsapp.net`);
              botLidUser = lidUser;
            }
          }

          // Flush queued messages
          flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

          // Group sync
          syncGroupMetadata().catch((err) => log.error('Initial group sync failed', { err }));
          if (!groupSyncTimerStarted) {
            groupSyncTimerStarted = true;
            setInterval(() => {
              syncGroupMetadata().catch((err) => log.error('Periodic group sync failed', { err }));
            }, GROUP_SYNC_INTERVAL_MS);
          }

          // Signal first open
          if (resolveFirstOpen) {
            resolveFirstOpen();
            resolveFirstOpen = undefined;
            rejectFirstOpen = undefined;
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // Invalidate cached group metadata when participants change (add/remove/
      // promote/demote). The next call to getNormalizedGroupMetadata will
      // refetch — cheaper than eagerly refreshing here, and avoids racing
      // with Baileys' own state propagation.
      sock.ev.on('group-participants.update', (update) => {
        try {
          if (update?.id) {
            groupMetadataCache.delete(update.id);
            log.debug('Invalidated group metadata cache', { jid: update.id, action: update.action });
          }
        } catch (err) {
          log.warn('Failed to handle group-participants.update', { err });
        }
      });

      // Baileys 7.x: built-in LIDMappingStore auto-tracks lid↔pn mappings.
      // Translation happens on-demand via signalRepository.lidMapping.getPNForLID
      // (see translateJid). No proactive event listener needed — this matches
      // v1's pattern. The 6.x `chats.phoneNumberShare` event was removed in 7.x.

      // Inbound messages
      sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
          try {
            if (!msg.message) continue;

            // Loop-break #1 (universal): if this key.id is in our send cache,
            // it's our own outbound coming back via WhatsApp's linked-device
            // echo. Covers text, files, stickers, reactions — anything that
            // went through sock.sendMessage. Beats the text-prefix check in
            // piggyback mode for archive-only outbounds (.pptx/.ogg/etc.)
            // where content === '' and the prefix detector misses.
            if (msg.key.id && sentMessageCache.has(msg.key.id)) {
              continue;
            }

            // Cache the original WAMessageKey so reactToMessage can recover
            // `participant` (required for reactions in groups).
            if (msg.key.id) {
              inboundKeyCache.set(msg.key.id, msg.key);
              if (inboundKeyCache.size > INBOUND_KEY_CACHE_MAX) {
                const oldest = inboundKeyCache.keys().next().value!;
                inboundKeyCache.delete(oldest);
              }
            }
            const normalized = normalizeMessageContent(msg.message);
            if (!normalized) continue;
            const rawJid = msg.key.remoteJid;
            if (!rawJid || rawJid === 'status@broadcast') continue;

            // Translate LID → phone JID
            let chatJid = await translateJid(rawJid);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (chatJid.endsWith('@lid') && (msg.key as any).senderPn) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const pn = (msg.key as any).senderPn as string;
              const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
              setLidPhoneMapping(rawJid.split('@')[0].split(':')[0], phoneJid);
              chatJid = phoneJid;
            }

            const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
            const isGroup = chatJid.endsWith('@g.us');

            // Notify metadata for group discovery
            setupConfig.onMetadata(chatJid, undefined, isGroup);

            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Normalize bot LID mention → assistant name for trigger matching
            if (botLidUser && content.includes(`@${botLidUser}`)) {
              content = content.replace(`@${botLidUser}`, `@${ASSISTANT_NAME}`);
            }

            // Download media attachments (images, video, audio, documents)
            const attachments = await downloadInboundMedia(msg, normalized);

            // Quoted/replied-to message: extract its text + re-download any
            // cited media so the agent can act on attachments the user is
            // pointing to (e.g. "ves este zip?" while citing a previous .zip).
            const quoted = await processQuotedMessage(msg, normalized);
            if (quoted) {
              attachments.push(...quoted.quotedAttachments);
              const quotedAudio = quoted.quotedAttachments.find((a) => a.type === 'audio');
              if (quotedAudio) {
                const audioPath = path.join(DATA_DIR, quotedAudio.localPath);
                const transcript = await transcribeAudioOptional(audioPath);
                if (transcript) {
                  content = content
                    ? `${quoted.prefix}\n[Voice in reply target: ${transcript}]\n${content}`
                    : `${quoted.prefix}\n[Voice in reply target: ${transcript}]`;
                  log.info('WhatsApp: quoted voice transcribed', { length: transcript.length });
                } else {
                  content = content ? `${quoted.prefix}\n${content}` : quoted.prefix;
                }
              } else {
                content = content ? `${quoted.prefix}\n${content}` : quoted.prefix;
              }
            }

            // Voice notes — transcribe (if WHISPER_BIN or OPENAI_API_KEY set)
            // and prefix the result to content so the agent reads the words
            // directly. Without transcription the agent only sees the file
            // path and would have to call a tool to listen to it. Same shape
            // as Signal v2 (PR #1962): "[Voice: <transcript>]".
            const audioAttachment = attachments.find(
              (a) => a.type === 'audio' && !quoted?.quotedAttachments.includes(a),
            );
            if (audioAttachment) {
              const audioPath = path.join(DATA_DIR, audioAttachment.localPath);
              const transcript = await transcribeAudioOptional(audioPath);
              if (transcript) {
                const voicePrefix = `[Voice: ${transcript}]`;
                content = content ? `${voicePrefix}\n${content}` : voicePrefix;
                log.info('WhatsApp: voice transcribed', { length: transcript.length });
              }
            }

            // Skip empty protocol messages (no text and no attachments)
            if (!content && attachments.length === 0) continue;

            // Resolve sender LID → phone JID so userId matches user_roles rows
            // (which are keyed by canonical phone JID). The chatJid above is
            // already translated; the sender needs the same treatment.
            const rawSender = msg.key.participant || msg.key.remoteJid || '';
            const sender = await translateJid(rawSender);
            const senderName = msg.pushName || sender.split('@')[0];
            const fromMe = msg.key.fromMe || false;
            // Loop-break: detect bot's own outbound echo.
            // Dedicated number: any fromMe is the bot itself.
            // Piggyback: all linked-device messages arrive fromMe=true (including
            // legit self-chat), so use the ASSISTANT_NAME prefix that the send
            // path stamps on bot output (see the prefixed branch below).
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`);
            if (isBotMessage) continue;

            // Check if this reply answers a pending question via slash command
            const pending = pendingQuestions.get(chatJid);
            if (pending && content.startsWith('/')) {
              const cmd = content.trim().toLowerCase();
              const matched = pending.options.find((o) => optionToCommand(o.label) === cmd);
              if (matched) {
                const voterName = msg.pushName || sender.split('@')[0];
                setupConfig.onAction(pending.questionId, matched.value, sender);
                pendingQuestions.delete(chatJid);
                await sendRawMessage(chatJid, `${matched.selectedLabel} by ${voterName}`);
                log.info('Question answered', {
                  questionId: pending.questionId,
                  value: matched.value,
                  voterName,
                });
                continue; // Don't forward this reply to the agent
              }
            }

            // For group messages, attach the participant roster so the agent
            // knows who is in the chat without having to ask. Capped at
            // PARTICIPANTS_INBOUND_CAP to keep prompt size bounded — for
            // larger groups we send count + admin-only list. Names aren't
            // included (Baileys' groupMetadata returns only IDs); the agent
            // gets phone numbers it can mention with `@<digits>`.
            let groupParticipants:
              | { ids: string[]; total: number; truncated: boolean }
              | undefined;
            if (isGroup) {
              const all = await getParticipantsList(chatJid);
              if (all) {
                const truncated = all.length > PARTICIPANTS_INBOUND_CAP;
                groupParticipants = {
                  ids: truncated ? all.slice(0, PARTICIPANTS_INBOUND_CAP) : all,
                  total: all.length,
                  truncated,
                };
              }
            }

            const inbound: InboundMessage = {
              id: msg.key.id || `wa-${Date.now()}`,
              kind: 'chat',
              content: {
                text: content,
                sender,
                senderName,
                ...(attachments.length > 0 && { attachments }),
                ...(groupParticipants && { participants: groupParticipants }),
                fromMe,
                isBotMessage,
                isGroup,
                chatJid,
              },
              timestamp,
            };

            // WhatsApp doesn't use threads — threadId is null
            setupConfig.onInbound(chatJid, null, inbound);

            // Send a read receipt so the user sees the blue ✓✓ — without
            // this the agent processes the message but the sender keeps
            // seeing single-✓ "delivered, not read", which feels broken.
            // Best-effort: WhatsApp sometimes rejects readMessages for
            // stale envelopes or non-private chats; swallow errors.
            try {
              await sock.readMessages([msg.key]);
            } catch (err) {
              log.debug('readMessages failed', { jid: chatJid, err });
            }
          } catch (err) {
            log.error('Error processing incoming WhatsApp message', {
              err,
              remoteJid: msg.key?.remoteJid,
            });
          }
        }
      });

      // Inbound reactions — surface as `[Reaction: <emoji>]` messages so the
      // agent sees when users react to its own messages. Reactions to other
      // people's messages are ignored to keep the inbox quiet. Reaction
      // removals (empty `reaction.text`) are also skipped.
      // Pattern ported from v1 src/channels/whatsapp.ts.
      sock.ev.on('messages.reaction', async (reactions) => {
        for (const { key, reaction } of reactions) {
          try {
            const emoji = reaction.text || '';
            if (!emoji) continue; // reaction was removed
            if (reaction.key?.fromMe) continue; // skip bot's own reactions
            if (!key.fromMe) continue; // only react to reactions on bot messages

            const chatJid = await translateJid(key.remoteJid || '');
            const rawSender = reaction.key?.participant || reaction.key?.remoteJid || '';
            const sender = await translateJid(rawSender);
            const senderName = sender.split('@')[0];
            const isGroup = chatJid.endsWith('@g.us');

            const inbound: InboundMessage = {
              id: `wa-rxn-${reaction.senderTimestampMs ?? Date.now()}`,
              kind: 'chat',
              content: {
                text: `[Reaction: ${emoji}]`,
                sender,
                senderName,
                reactionTo: key.id,
                fromMe: false,
                isBotMessage: false,
                isGroup,
                chatJid,
              },
              timestamp: new Date(
                Number(reaction.senderTimestampMs ?? Date.now()),
              ).toISOString(),
            };
            setupConfig.onInbound(chatJid, null, inbound);
          } catch (err) {
            log.error('Error processing reaction', { err, remoteJid: key?.remoteJid });
          }
        }
      });
    }

    // --- ChannelAdapter implementation ---

    const adapter: ChannelAdapter = {
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,

      async setup(hostConfig: ChannelSetup) {
        setupConfig = hostConfig;

        // Connect and wait for first open
        await new Promise<void>((resolve, reject) => {
          resolveFirstOpen = resolve;
          rejectFirstOpen = reject;
          connectSocket().catch(reject);
        });

        log.info('WhatsApp adapter initialized');
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        const content = message.content as Record<string, unknown>;

        // Ask question → text with slash command replies
        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          const question = content.question as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          const options: NormalizedOption[] = normalizeOptions(content.options as never);

          const optionLines = options.map((o) => `  ${optionToCommand(o.label)}`).join('\n');
          const text = `*${title}*\n\n${question}\n\nResponde con:\n${optionLines}`;
          const msgId = await sendRawMessage(platformId, text);
          if (msgId) {
            pendingQuestions.set(platformId, { questionId, options });
            if (pendingQuestions.size > PENDING_QUESTIONS_MAX) {
              const oldest = pendingQuestions.keys().next().value!;
              pendingQuestions.delete(oldest);
            }
          }
          return msgId;
        }

        // Reaction → emoji on a message
        if (content.operation === 'reaction' && content.messageId && content.emoji) {
          try {
            await sock.sendMessage(platformId, {
              react: {
                text: content.emoji as string,
                key: { remoteJid: platformId, id: content.messageId as string, fromMe: false },
              },
            });
          } catch (err) {
            log.debug('Failed to send reaction', { platformId, err });
          }
          return;
        }

        // Group subject (title) update — bot must be admin
        if (content.operation === 'group_subject' && content.subject) {
          try {
            await sock.groupUpdateSubject(platformId, content.subject as string);
            log.info('WhatsApp: group subject updated', { platformId, subject: content.subject });
          } catch (err) {
            log.warn('Failed to update group subject', { platformId, err });
          }
          return;
        }

        // Group photo/avatar update — bot must be admin. `file` is the
        // first item of message.files (set by the MCP tool).
        if (content.operation === 'group_photo' && message.files && message.files.length > 0) {
          try {
            const buffer = message.files[0].data;
            await sock.updateProfilePicture(platformId, buffer);
            log.info('WhatsApp: group photo updated', { platformId });
          } catch (err) {
            log.warn('Failed to update group photo', { platformId, err });
          }
          return;
        }

        // Group invite link — generate via Baileys and send as a chat
        // message. Bot must be admin. Optional `text` is prepended.
        if (content.operation === 'group_invite_link') {
          try {
            const code = await sock.groupInviteCode(platformId);
            if (!code) {
              log.warn('No invite code returned', { platformId });
              return;
            }
            const link = `https://chat.whatsapp.com/${code}`;
            const prefix = (content.text as string) || '';
            const body = prefix ? `${prefix}\n${link}` : link;
            const finalText = ASSISTANT_HAS_OWN_NUMBER ? body : `${ASSISTANT_NAME}: ${body}`;
            await sendRawMessage(platformId, finalText);
            log.info('WhatsApp: invite link sent', { platformId });
          } catch (err) {
            log.warn('Failed to get/send invite link', { platformId, err });
          }
          return;
        }

        // Native poll. Container emits `content.poll = { name, options, selectableCount? }`
        // via the send_poll MCP tool; we render as a Baileys poll message.
        // Polls don't support captions or attachments — handled inline and
        // returned before the text/file path.
        if (content.poll && typeof content.poll === 'object') {
          const poll = content.poll as { name?: string; options?: string[]; selectableCount?: number };
          if (!poll.name || !Array.isArray(poll.options) || poll.options.length < 2) {
            log.warn('Invalid poll payload, skipping', { platformId, poll });
            return;
          }
          try {
            const sent = await sock.sendMessage(platformId, {
              poll: {
                name: poll.name,
                values: poll.options,
                selectableCount: poll.selectableCount && poll.selectableCount > 0 ? poll.selectableCount : 1,
              },
            });
            if (sent?.key?.id && sent.message) {
              sentMessageCache.set(sent.key.id, sent.message);
            }
            log.info('WhatsApp: poll sent', { platformId, name: poll.name, options: poll.options.length });
          } catch (err) {
            log.warn('Failed to send poll', { platformId, err });
          }
          return;
        }

        // Normal message (with optional file attachments)
        const rawText = (content.markdown as string) || (content.text as string);
        const hasFiles = message.files && message.files.length > 0;

        if (!rawText && !hasFiles) return;

        // Resolve + rewrite mentions once. resolveMentionsAndRewrite returns
        // both the (possibly rewritten) text and the JID array Baileys needs
        // — we apply both to caption and standalone-text paths so @Name
        // mentions render consistently. Computed before the file loop so an
        // async metadata fetch (for @all / @Name resolution) doesn't block
        // per-file sends.
        const { text: captionText, mentions: captionMentions } = rawText
          ? await resolveMentionsAndRewrite(platformId, rawText)
          : { text: '', mentions: [] as string[] };
        const text = rawText ? captionText : rawText;

        // Send file attachments. Caption goes on the first file that
        // supports captions (stickers don't — `.webp` is a native sticker,
        // it doesn't render text alongside, so we'd lose the caption if we
        // tried). If no file accepts the caption, the text falls through to
        // the plain-text path below.
        if (hasFiles) {
          let captionUsed = false;
          for (const file of message.files!) {
            try {
              const ext = path.extname(file.filename).toLowerCase();
              const supportsCaption = ext !== '.webp';
              const caption = !captionUsed && supportsCaption ? text : undefined;
              const mediaMsg = buildMediaMessage(file.data, file.filename, ext, caption);
              const payload =
                caption && captionMentions.length > 0
                  ? { ...mediaMsg, mentions: captionMentions }
                  : mediaMsg;
              const sent = await sock.sendMessage(platformId, payload);
              if (sent?.key?.id && sent.message) {
                sentMessageCache.set(sent.key.id, sent.message);
              }
              if (caption) captionUsed = true;
            } catch (err) {
              log.error('Failed to send file', { platformId, filename: file.filename, err });
            }
          }
          if (captionUsed) return; // Text was sent as caption
        }

        if (text) {
          const formatted = formatWhatsApp(text);
          const prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : `${ASSISTANT_NAME}: ${formatted}`;
          // Re-resolve on the prefixed text so any prefix-introduced shifts
          // are accounted for (cosmetic — Baileys matches by literal substring,
          // not byte offset — but keeps payload consistent).
          const { text: finalText, mentions: finalMentions } = await resolveMentionsAndRewrite(platformId, prefixed);
          return sendRawMessage(platformId, finalText, finalMentions);
        }
      },

      async setTyping(platformId: string) {
        try {
          await sock.sendPresenceUpdate('composing', platformId);
        } catch (err) {
          log.debug('Failed to update typing status', { jid: platformId, err });
        }
      },

      async reactToMessage(platformId: string, messageId: string, emoji: string) {
        if (!connected) return;
        // Identical to v1 sendReaction: { remoteJid, id, participant }
        // with participant taken raw from the cached WAMessageKey, no
        // translation. v1 in piggyback mode works exactly this way.
        const cachedKey = inboundKeyCache.get(messageId);
        const key: { remoteJid: string; id: string; participant?: string } = {
          remoteJid: platformId,
          id: messageId,
        };
        if (cachedKey?.participant) key.participant = cachedKey.participant;
        log.info('reactToMessage', { platformId, messageId, emoji, participant: key.participant });
        try {
          await sock.sendMessage(platformId, { react: { text: emoji, key } });
          log.info('reactToMessage sent', { platformId, messageId });
        } catch (err) {
          log.warn('Failed to react to message', { platformId, messageId, err });
        }
      },

      async teardown() {
        connected = false;
        sock?.end(undefined);
        log.info('WhatsApp adapter shut down');
      },

      isConnected() {
        return connected;
      },

      async syncConversations(): Promise<ConversationInfo[]> {
        try {
          const groups = await sock.groupFetchAllParticipating();
          return Object.entries(groups)
            .filter(([, m]) => m.subject)
            .map(([jid, m]) => ({
              platformId: jid,
              name: m.subject,
              isGroup: true,
            }));
        } catch (err) {
          log.error('Failed to sync WhatsApp conversations', { err });
          return [];
        }
      },

      async createGroup(subject: string): Promise<{ platformId: string; inviteLink: string | null }> {
        if (!connected || !sock) {
          throw new Error('WhatsApp adapter is not connected');
        }
        const meta = await sock.groupCreate(subject, []);
        const platformId = meta.id;
        // Defensive: groupCreate normally returns @g.us — flag if WA changes
        // and we get @lid (would force a translateJid follow-up before we can
        // wire it).
        if (!platformId.endsWith('@g.us')) {
          log.warn('groupCreate returned non-@g.us platform_id', { platformId });
        }
        let inviteLink: string | null = null;
        try {
          const code = await sock.groupInviteCode(platformId);
          if (code) inviteLink = `https://chat.whatsapp.com/${code}`;
        } catch (err) {
          log.warn('groupInviteCode failed after groupCreate', { platformId, err });
        }
        log.info('WhatsApp group created', { platformId, subject, hasInvite: inviteLink !== null });
        return { platformId, inviteLink };
      },

      async getInviteLink(platformId: string): Promise<string | null> {
        if (!connected || !sock) {
          throw new Error('WhatsApp adapter is not connected');
        }
        try {
          const code = await sock.groupInviteCode(platformId);
          return code ? `https://chat.whatsapp.com/${code}` : null;
        } catch (err) {
          log.warn('groupInviteCode failed', { platformId, err });
          return null;
        }
      },

      async leaveGroup(platformId: string): Promise<void> {
        if (!connected || !sock) {
          throw new Error('WhatsApp adapter is not connected');
        }
        await sock.groupLeave(platformId);
        log.info('WhatsApp group left', { platformId });
      },

      async renameGroup(platformId: string, newName: string): Promise<void> {
        if (!connected || !sock) {
          throw new Error('WhatsApp adapter is not connected');
        }
        await sock.groupUpdateSubject(platformId, newName);
        log.info('WhatsApp group renamed', { platformId, newName });
      },
    };

    return adapter;
  },
});
