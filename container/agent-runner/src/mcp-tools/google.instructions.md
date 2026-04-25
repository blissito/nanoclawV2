# Google Workspace

The agent has 5 Gmail/Calendar/Drive tools backed by Google's regular REST APIs, plus `google_workspace_status` for onboarding.

## ⚠️ Per-user accounts

Each USER in the group has their own Google connection. **You always act on behalf of a specific person**, never on behalf of the group. Every Google tool requires `as_user_id` — pass the `from_user_id` of the message that triggered the request (it's in the inbound `<message from="...">` wrapper).

If Pedro asks to "manda un correo" → call `gmail_send` with `as_user_id = "whatsapp:521...pedro@s.whatsapp.net"`. The email goes from Pedro's account.
If Marina then asks the same → `as_user_id = "whatsapp:521...marina@s.whatsapp.net"`. The email goes from Marina's.

You **cannot** use one user's account to act on behalf of another. If Marina hasn't connected her Google, you cannot fall back to Pedro's — you must ask Marina to connect her own (the tool returns the magic link automatically).

## google_workspace_status

Check whether a SPECIFIC user has connected their Google Workspace. Optional in practice — every other tool auto-checks and returns a magic link if not connected. Useful when the user explicitly asks "¿conecté Google?".

Required arg: `as_user_id`.

Returns `{connected: true, email}` or `{connected: false, magic_link}`. When `connected: false`, the magic link is single-use, expires in 10 min, and is **scoped to that specific user** — only their click stores credentials for them.

## When the user isn't connected

Every tool below auto-handles this. If you call `gmail_send` for a user who hasn't authorized, the tool returns an error with the magic_link inline. Just send the link to **that user** verbatim:

> Para mandar correos necesito que conectes tu Workspace, click aquí (1 click, autorizan en Google):
> https://ghosty.studio/oauth/google/start?state=...

**Send the literal URL** — do not paraphrase, do not put it behind markdown link text. The container will exit at end-of-turn, so the user's next message after authorizing wakes a fresh container with their tools available.

## calendar_list_events

List events from `as_user_id`'s primary calendar. Required: `as_user_id`. Defaults: next 7 days, max 20.

## calendar_create_event

Create an event in `as_user_id`'s primary calendar. Required: `as_user_id`, `summary`, `startTime`. Optional: `endTime` (default start+30m), `description`, `location`, `attendees` (list of emails), `timeZone` (default `America/Mexico_City`).

**ALWAYS pass `timeZone`** — the container runs UTC. If the user says "9pm" interpret in their local TZ from the `<context timezone="..."/>` header and pass it explicitly. The `dateTime` field MAY include an offset like `-06:00` AND `timeZone` should also be set; Google uses both consistently.

After creating, return the `link` (htmlLink) so the user can confirm/edit in Google Calendar.

## gmail_send

Send an email FROM `as_user_id`'s connected Gmail. The `From` is automatically that user's email. Required: `as_user_id`, `to`, `subject`, and either `body` or `bodyHtml`.

Confirm the recipient + subject if ambiguous. Summary after sending: *"📤 enviado desde tu-email@... a juan@... — asunto X"*.

## gmail_search

Search `as_user_id`'s Gmail using Gmail's query syntax (`from:`, `subject:`, `is:unread`, `after:YYYY/MM/DD`, etc.). Required: `as_user_id`, `q`.

Returns id + from + subject + date + snippet for each match. Full-body fetch is not yet exposed — tell the user that limitation if they ask for one.

## drive_search

Search `as_user_id`'s Drive using Drive query syntax. Required: `as_user_id`, `q`.

Examples: `name contains 'reporte'`, `mimeType = 'application/vnd.google-apps.document'`, `modifiedTime > '2026-04-01T00:00:00'`.

Returns file id, name, mimeType, modifiedTime, webViewLink.

## What's NOT here yet

- Reading file/email body content. Easy add (~30 LOC each) when a real need shows up.
- Updating/deleting calendar events.
- Gmail draft management.
