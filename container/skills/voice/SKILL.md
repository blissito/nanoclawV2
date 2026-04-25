---
name: voice
description: Text-to-speech with Mexican Spanish voices (ElevenLabs) and voice cloning. OpenAI TTS fallback.
allowed-tools: Bash(text-to-speech:*),Bash(clone-voice:*),Bash(ffmpeg:*),Bash(yt-dlp:*)
---

# Voice Replies

Generate audio when the user asks for voice or when replying to a voice note feels natural.

## Voice catalog

| Voice | Style | When to use |
|-------|-------|-------------|
| `antonio` | Confident, gentle, latino | **Default** — everyday conversation |
| `jc` | Energetic, broadcaster | News, data, exciting updates |
| `brian` | Warm, soft, podcast | Long explanations, calm tone |
| `daniel` | Young, natural, casual | Casual banter, young audience |
| `enrique` | Rich, credible, narrator | Serious narration, formal reports |
| `maya` | Dynamic, Mexican female | Female storytelling, energetic |
| `cristina` | Young, conversational, Mexican female | Female casual chat |
| `regina` | Sweet, friendly, Mexican female | Female warm/professional |
| `custom` | Cloned voice | When the group has a cloned voice |

```bash
text-to-speech "Qué onda, aquí el resumen de hoy" antonio
text-to-speech "Última hora: el servidor está al 99% de uptime" jc
text-to-speech "Te explico cómo funciona el sistema de pagos" brian
text-to-speech "Esto con la voz personalizada" custom
```

## Sending voice

```
mcp__nanoclaw__send_message({ text: "voice", audio_path: "/workspace/agent/tts-XXX.ogg" })
```

## Voice cloning

### From audio attachment

```bash
clone-voice /workspace/agent/attachments/audio-123.ogg "voice-name"
```

### From video attachment (extract audio first)

```bash
ffmpeg -i /workspace/agent/attachments/video.mp4 -vn -acodec libopus /workspace/agent/extracted-audio.ogg -y
clone-voice /workspace/agent/extracted-audio.ogg "voice-name"
```

### From YouTube link

YouTube blocks all requests without cookies. The container needs `/workspace/youtube-cookies.txt` mounted RO. If it's not present, tell the user to register the mount via `additionalMounts` in the group's `container.json`.

```bash
cp /workspace/youtube-cookies.txt /tmp/yt-cookies.txt
yt-dlp --cookies /tmp/yt-cookies.txt -x --audio-format wav -o "/workspace/agent/yt-audio.%(ext)s" "YOUTUBE_URL"
clone-voice /workspace/agent/yt-audio.wav "voice-name"
```

The cookies file must be copied to `/tmp/` first because yt-dlp needs to write to it.

**Warn the user first** — YouTube + cloning takes 1-2 minutes:

```
mcp__nanoclaw__send_message({ text: "Descargando audio de YouTube y clonando la voz, dame 1-2 min..." })
```

For best results, pick a video with clear speech (no music, no background noise).

### After cloning

The script saves to `/workspace/agent/voice_config.json` and you can use `text-to-speech "text" custom` thereafter. To stop using the cloned voice: delete that file.

## Important

- Always write text in Mexican Spanish with natural, casual expressions.
- Only use voice when explicitly asked or when replying to a voice note.
- Do NOT call TTS APIs directly — always use these scripts. Auth is via OneCLI proxy.
- Voice cloning needs at least 10 seconds of clear audio (30s+ is better).

## Troubleshooting

- **`401 Unauthorized` from ElevenLabs / OpenAI**: OneCLI secret not assigned. Tell the user to re-run `/add-voice` on the host.
- **`yt-dlp: command not found`**: package missing from the agent's container. Re-run `/add-voice` on the host (it adds `yt-dlp` to `packages.apt`).
- **YouTube fails with HTTP 403**: cookies are stale or not mounted. Re-export from your browser and update the host file.
