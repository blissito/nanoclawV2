# Google Workspace

The agent has 24 tools across Gmail / Calendar / Drive / Sheets / Docs / Meet, backed by Google's REST APIs, plus `google_workspace_status` for onboarding.

## ⛔ Two hard rules

1. **Google tools NEVER use OneCLI.** OneCLI is for Anthropic / EasyBits / BrightData / etc. Google authentication lives in `ghosty.studio` (separate OAuth dance). Do NOT, under any circumstance, send the user a `127.0.0.1:10254` link, mention OneCLI, or say "hay que conectar X en OneCLI" for any Google action. If a Google tool needs auth, IT will return a `magic_link` field — pass that link verbatim, nothing else.

2. **TRY THE TOOL FIRST. Always.** Do not predict what will fail and pre-emptively ask the user for setup. If the user says "crea un Meet", call `meet_create_space`. If it works, great. If it fails with a magic link in the error, send THAT link. Never invent a setup step from your training data — the host wires what's wired, and the tool itself reports what it needs.

## ⚠️ Per-user accounts

Each USER in the group has their own Google connection. **You always act on behalf of a specific person**, never on behalf of the group. Every Google tool requires `as_user_id` — pass the `from_user_id` of the message that triggered the request (it's in the inbound `<message from="...">` wrapper).

If Pedro asks to "manda un correo" → call `gmail_send` with `as_user_id = "whatsapp:521...pedro@s.whatsapp.net"`. The email goes from Pedro's account.
If Marina then asks the same → `as_user_id = "whatsapp:521...marina@s.whatsapp.net"`. The email goes from Marina's.

You **cannot** use one user's account to act on behalf of another. If Marina hasn't connected her Google, you cannot fall back to Pedro's — you must ask Marina to connect her own (the tool returns the magic link automatically).

## google_workspace_status

Check whether a SPECIFIC user has connected their Google Workspace. Optional in practice — every other tool auto-checks and returns a magic link if not connected. Useful when the user explicitly asks "¿conecté Google?".

Required arg: `as_user_id`. Returns `{connected: true, email}` or `{connected: false, magic_link}`.

## When the user isn't connected

Every tool below auto-handles this. If you call `gmail_send` for a user who hasn't authorized, the tool returns an error with the magic_link inline. Send the link to **that user** verbatim:

> Para mandar correos necesito que conectes tu Workspace, click aquí (1 click, autorizan en Google):
> https://ghosty.studio/oauth/google/start?state=...

**Send the literal URL** — do not paraphrase, do not put it behind markdown link text. The container will exit at end-of-turn, so the user's next message after authorizing wakes a fresh container with their tools available.

---

# Gmail

## gmail_send
Send an email FROM `as_user_id`'s Gmail. Required: `as_user_id`, `to`, `subject`, and either `body` or `bodyHtml`. Confirm recipient + subject if ambiguous.

## gmail_search
Search `as_user_id`'s Gmail with Gmail query syntax (`from:`, `subject:`, `is:unread`, `after:YYYY/MM/DD`). Required: `as_user_id`, `q`. Returns id + headers + snippet only — use `gmail_read_message` for full body.

## gmail_read_message
Fetch full body of a single message by id. Returns from/to/cc/subject/date/body (plain preferred, HTML stripped to text). Use after `gmail_search` when the user wants "lee ese correo".

## gmail_reply
Reply within an existing thread (preserves threadId, In-Reply-To, References, auto `Re:` subject). Required: `as_user_id`, `message_id`, `body`. Optional `reply_all` (default false → just original sender).

## gmail_modify_labels
Add / remove labels on a message. Patterns:
- Mark read: `removeLabelIds=['UNREAD']`
- Archive: `removeLabelIds=['INBOX']`
- Trash: `addLabelIds=['TRASH']`
- Star: `addLabelIds=['STARRED']`

System labels: INBOX, UNREAD, STARRED, IMPORTANT, SENT, TRASH, SPAM, DRAFT.

---

# Calendar

## calendar_list_events
List events from a calendar (default `primary`). Defaults: next 7 days, max 20.

## calendar_create_event
Create event. Required: `as_user_id`, `summary`, `startTime`. Optional: `endTime` (default +30m), `description`, `location`, `attendees`, `timeZone` (default `America/Mexico_City`), `add_meet`.

**ALWAYS pass `timeZone`** — container is UTC, naive dateTime saves 6h off. Interpret user's "9pm" in their TZ from the `<context timezone="..."/>` header.

**ALWAYS include `link` in your reply** (Google Calendar URL — user wants to tap-confirm). Format:
> Listo ✅ Evento creado: **<summary>** <fecha legible> (<TZ>)
> 🔗 <link>

If `add_meet=true`, response also includes `meet_link` — paste it after the event link:
> 🎥 Meet: <meet_link>

## calendar_update_event
Update existing event. Pass only fields to change. To **add** invitees without dropping existing use `attendees_add` (merges); use `attendees` only to fully replace. Same `add_meet` flag works to attach Meet to an event that didn't have one.

## calendar_delete_event
Permanently delete event. **Confirm first** unless user said "borra/elimina/cancela" explicitly.

## calendar_list_calendars
List user's calendars (primary + secondary like work, family, subscribed). Returns id, summary, accessRole, primary flag, timeZone. Use the id as `calendarId` in other Calendar tools to target a non-primary one.

## calendar_freebusy
Check free/busy windows for one or more calendars in a time range. Use for "cuándo coincidimos brenda y yo esta semana". Returns busy intervals per email; **YOU compute the gaps** and propose times. Required: `as_user_id`, `emails` (array), `timeMin`, `timeMax`.

---

# Drive

## drive_search
Search Drive with Drive query syntax. Examples:
- `name contains 'reporte'`
- `mimeType = 'application/vnd.google-apps.document'`
- `mimeType = 'application/vnd.google-apps.spreadsheet'`
- `modifiedTime > '2026-04-01T00:00:00'`

Returns file id, name, mimeType, modifiedTime, webViewLink.

## drive_download
Download a Drive file into `/workspace/agent/` and return the path. After download, send via `mcp__nanoclaw__send_file({path})`.

For native Google types (Docs/Sheets/Slides) you MUST pass `export_mime`:
- Docs → `application/pdf` | `text/plain` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- Sheets → `text/csv` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Slides → `application/pdf` | `application/vnd.openxmlformats-officedocument.presentationml.presentation`

For binary files (PDFs, images, videos, .xlsx, .docx) — no export_mime needed.

## drive_upload
Upload a local workspace file to Drive. Returns id + `link`. Optional `parent_folder_id` to land in a specific folder. Use `drive_share` after to give others access.

## drive_share
Add a permission. Roles: `reader`, `commenter`, `writer`. Default `notify=true` so Google emails the recipient. Pass `message` for a custom note. Use `share_with='anyone'` for public link sharing.

## drive_create_folder
Create a folder. Returns id + link. Optional `parent_folder_id` to nest. Pair with `drive_upload`/`drive_move` to organize.

## drive_move
Move file/folder to a different parent (removes from current parents).

---

# Sheets

## sheets_read
Read values from a Sheet. Required: `as_user_id`, `spreadsheet` (id or URL).
- No `range` → returns `{title, tabs[], preview (first 50 rows of first tab)}`.
- With `range` (A1) → just the cells.

Only works on native Google Sheets, not `.xlsx` uploads.

## sheets_write
Write values. Required: `as_user_id`, `spreadsheet`, `range`, `values` (2D array). Modes:
- `update` (default) — replace cells in range.
- `append` — add rows after last non-empty row in range/tab. Use for log rows.

`valueInputOption='USER_ENTERED'` (default) parses formulas/dates like the UI; `RAW` stores literal strings.

---

# Docs

## docs_read
Read text content of a Google Doc. Returns title + plain-text body (formatting dropped, line breaks preserved, tables flattened to pipe-separated rows). Use after `drive_search` finds a Doc.

## docs_create
Create a new Google Doc. Returns id + link. Optional `body` inserts plain text at top. Use `drive_move` after to organize into a folder; the doc lands in My Drive root by default.

## docs_append
Append plain-text content at the end of an existing Doc. Adds a leading newline if doc isn't empty.

---

# Meet

There are two ways to spin up a Meet link — pick based on whether it ties to a calendar event:

## Calendar-attached Meet (preferred)
Pass `add_meet=true` to `calendar_create_event` or `calendar_update_event`. Google generates the Meet link, attaches it to the event, and notifies attendees automatically. Response includes `meet_link`.

## meet_create_space
Standalone Meet space, no calendar event. For "dame un Meet ya pa hablar". Returns the meeting URI (`https://meet.google.com/xxx-yyyy-zzz`).

## meet_list_recent_conferences
List finished Meet conferences. Default window: last 7 days, max 10. Returns each conference's name (id), space, start/end. Use the conference name in the next two tools.

## meet_get_recording
Returns Drive video file ids for a past conference's recordings. Combine with `drive_download` (no export_mime — videos are binary) to fetch the actual file. Empty array if not recorded.

## meet_get_transcript
Returns the transcript Doc id + a flat list of `{speaker, text, start}` entries for a past conference. Combine with `docs_read` for full text. Empty if no transcript was generated.

**Workflow:** "qué dije en la junta del lunes con brenda" →
1. `meet_list_recent_conferences` → find the right conference name
2. `meet_get_transcript` → get entries OR doc_id
3. Summarize entries directly, or `docs_read` the full transcript Doc.

---

# What's NOT here

- Gmail drafts, Gmail attachments, Gmail send-with-attachment.
- Sheets formatting (bold, colors), Sheets create new spreadsheet, Sheets new-tab.
- Slides, Forms, Contacts (People), Tasks, Keep.
- Drive trash/delete, Drive copy.
