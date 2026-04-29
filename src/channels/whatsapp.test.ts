/**
 * Pure-helper tests for the WhatsApp adapter. Covers the mention parser
 * and the `@all` expansion. Anything that needs a live Baileys socket is
 * verified post-deploy in WhatsApp itself.
 */
import { describe, expect, it } from 'vitest';

import { expandAllMentions, parseMentions } from './whatsapp.js';

describe('parseMentions', () => {
  it('extracts a single phone JID', () => {
    const r = parseMentions('oye @5217712412825 mira esto');
    expect(r.mentions).toEqual(['5217712412825@s.whatsapp.net']);
    expect(r.hasAll).toBe(false);
  });

  it('extracts multiple distinct mentions', () => {
    const r = parseMentions('cc @5217712412825 y @5217757609276');
    expect(r.mentions).toEqual([
      '5217712412825@s.whatsapp.net',
      '5217757609276@s.whatsapp.net',
    ]);
  });

  it('dedupes repeated mentions', () => {
    const r = parseMentions('@5217712412825 hola @5217712412825 otra vez');
    expect(r.mentions).toEqual(['5217712412825@s.whatsapp.net']);
  });

  it('ignores email addresses', () => {
    const r = parseMentions('manda a hola@empresa.com');
    expect(r.mentions).toEqual([]);
  });

  it('ignores too-short and too-long digit runs', () => {
    // 7 digits → too short for any country
    const r1 = parseMentions('precio @1234567 quizá');
    expect(r1.mentions).toEqual([]);
    // 16 digits → not a phone JID
    const r2 = parseMentions('id @1234567890123456 wtf');
    expect(r2.mentions).toEqual([]);
  });

  it('handles trailing punctuation', () => {
    const r = parseMentions('@5217712412825, ¿estás?');
    expect(r.mentions).toEqual(['5217712412825@s.whatsapp.net']);
  });

  it('detects @all (case-insensitive)', () => {
    expect(parseMentions('@all reunión 5pm').hasAll).toBe(true);
    expect(parseMentions('@ALL urgente').hasAll).toBe(true);
    expect(parseMentions('hola @All').hasAll).toBe(true);
  });

  it('detects @todos (Spanish)', () => {
    expect(parseMentions('@todos hagan ping').hasAll).toBe(true);
    expect(parseMentions('cc @TODOS').hasAll).toBe(true);
  });

  it('does not match @allá or @todosanchez (word boundary)', () => {
    expect(parseMentions('voy @allá').hasAll).toBe(false);
    expect(parseMentions('hola @todosanchez').hasAll).toBe(false);
  });
});

describe('expandAllMentions', () => {
  it('returns digit mentions unchanged when @all is absent', () => {
    const r = expandAllMentions({
      parsed: { mentions: ['5217712412825@s.whatsapp.net'], hasAll: false },
      participants: ['5217712412825@s.whatsapp.net', '5217757609276@s.whatsapp.net'],
    });
    expect(r).toEqual(['5217712412825@s.whatsapp.net']);
  });

  it('expands to all participants when @all is present', () => {
    const r = expandAllMentions({
      parsed: { mentions: [], hasAll: true },
      participants: ['5217712412825@s.whatsapp.net', '5217757609276@s.whatsapp.net'],
    });
    expect(r.sort()).toEqual([
      '5217712412825@s.whatsapp.net',
      '5217757609276@s.whatsapp.net',
    ].sort());
  });

  it('merges digit mentions with @all expansion (deduped)', () => {
    const r = expandAllMentions({
      parsed: { mentions: ['5217712412825@s.whatsapp.net'], hasAll: true },
      participants: ['5217712412825@s.whatsapp.net', '5217757609276@s.whatsapp.net'],
    });
    expect(r.sort()).toEqual([
      '5217712412825@s.whatsapp.net',
      '5217757609276@s.whatsapp.net',
    ].sort());
  });

  it('falls back to digit mentions when participants is null', () => {
    const r = expandAllMentions({
      parsed: { mentions: ['5217712412825@s.whatsapp.net'], hasAll: true },
      participants: null,
    });
    expect(r).toEqual(['5217712412825@s.whatsapp.net']);
  });

  it('handles empty participants list', () => {
    const r = expandAllMentions({
      parsed: { mentions: [], hasAll: true },
      participants: [],
    });
    expect(r).toEqual([]);
  });
});
