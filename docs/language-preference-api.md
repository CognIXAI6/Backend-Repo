# Language Preference API

**Status:** Backend implemented and tested (Workstream A). Frontend wiring not yet done.
**Audience:** Frontend engineers (web/iOS/Android) integrating conversation-language preferences.

The AI now generates every conversation response, insight, and auto-title in a language the user chooses — separate from whatever language the app's own buttons and menus are in. This document is the contract for wiring a client to it.

## Two settings, not one

| `appLanguage` | `conversationOutputLanguage` |
| --- | --- |
| Frontend-only, already built. The "App Language" picker in Settings. Pure client-side i18n — relabels buttons, menus, static strings. No API call today. | This handoff. What language the AI writes its replies, insights, summaries, and titles in. Lives on the backend as `user_preferences.language`. |

**Product decision:** these two are to be kept in sync, always. Every time the user changes App Language, also call the AI-preferences endpoint below with the same code. One selector, two effects. See "What to wire up."

## Supported languages

Call `GET /settings/languages` rather than hand-maintaining this list — it's the live source of truth and will grow without a client update.

| Code | Name | Notes |
| --- | --- | --- |
| `en` | English | Default for guests and unset preferences |
| `es` | Spanish | |
| `fr` | French | |
| `de` | German | |
| `zh-Hans` | Simplified Chinese | |
| `zh-Hant` | Traditional Chinese | |
| `yo` | Yoruba | text-only — no speech recognition yet |
| `ha` | Hausa | text-only — no speech recognition yet |
| `ig` | Igbo | text-only — no speech recognition yet |

"Text-only" means the AI writes it correctly, but the speech-to-text provider has no recognizer for it yet — don't offer it as a live-voice input language, only as an output/typing language, until that changes.

## Endpoints

### List supported languages

```http
GET /api/v1/settings/languages
Authorization: Bearer <token>
```

Full list of codes the AI can generate output in. Use this to populate every language picker — App Language included.

**Response · 200**

```json
{
  "status": "success",
  "data": [
    { "code": "en", "name": "English" },
    { "code": "es", "name": "Spanish" },
    { "code": "fr", "name": "French" },
    { "code": "de", "name": "German" },
    { "code": "zh-Hans", "name": "Simplified Chinese" },
    { "code": "zh-Hant", "name": "Traditional Chinese" },
    { "code": "yo", "name": "Yoruba" },
    { "code": "ha", "name": "Hausa" },
    { "code": "ig", "name": "Igbo" }
  ]
}
```

### Read current preferences

```http
GET /api/v1/settings/ai-preferences
Authorization: Bearer <token>
```

Current preferences for the signed-in user, including the conversation output language.

**Response · 200**

```json
{
  "status": "success",
  "data": {
    "responseLength": "balanced",
    "tone": "professional",
    "language": "es",
    "customInstructions": null
  }
}
```

### Update preferences

```http
PUT /api/v1/settings/ai-preferences
Authorization: Bearer <token>
Content-Type: application/json
```

Partial update — send only the field you're changing. `tone` and `responseLength` are untouched when you send `language` alone.

**Request**

```json
{ "language": "es" }
```

**Response · 200**

```json
{
  "status": "success",
  "data": {
    "responseLength": "balanced",
    "tone": "professional",
    "language": "es",
    "customInstructions": null
  }
}
```

**Response · 400** (invalid, null, or empty code)

```json
{
  "statusCode": 400,
  "message": ["language must be a valid enum value"],
  "correlationId": "…"
}
```

## What to wire up

This is the actual client-side task — everything else in this document is context.

1. Wherever the App Language selection is currently saved (the handler behind those radio buttons), also call `PUT /settings/ai-preferences` with `{ "language": "<same code>" }`, for signed-in users only.
2. Switch the UI language first and unconditionally. The API call is a side effect — if it fails (expired token, network blip), the interface still changes; don't roll it back or block on the request.
3. Skip the call entirely for guests/unauthenticated sessions — there's no account to persist a preference to. AI output stays English for guests regardless of App Language.
4. Don't add a second language control anywhere else (e.g. under "AI Behaviour"). One selector now drives both UI and AI-output language — a second one would fight this one for the same value.

## What you get for free

No other client changes are needed — these already use whatever language is saved, automatically:

- `POST /chat/messages` (durable chat) — response text and conversation title
- Socket `text:send`, single/dual/multi-speaker voice turns — same
- Mid-session language changes — switching the saved preference mid-call takes effect on the very next AI turn, same socket connection, no reconnect, no microphone restart
- Server-generated fallback text ("I didn't quite catch that…", document-ready confirmations) — localized too

## Not yet available

**Speech recognition**
- Transcripts are recognized in English regardless of output language — the recognizer itself isn't language-aware yet
- No live translated-transcript stream

**Elsewhere**
- No endpoint yet to translate an already-saved message/transcript/title on demand
- Error responses don't carry a stable machine-readable `code` field yet — match on `statusCode` for now

---

Yoruba/Hausa/Igbo copy (and to a lesser extent Spanish/French/German/Chinese) in server-generated fallback text is a first machine-drafted pass — flag anything that reads wrong to a native speaker.
