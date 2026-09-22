# Document generation — findings

**Verdict: not a mobile-specific bug.** The fix is committed and pushed to `origin/main`. What's still failing on mobile matches the pre-fix behavior exactly, which points to the server running an old build rather than a code issue.

Repo: `cognix-api` · Branch: `main` · Sept 2026

---

## Action needed before retesting

Migrations were re-run on the server, but that doesn't rebuild or restart the app. If document generation still fails on mobile, the app process is almost certainly still running the old code:

```bash
git pull
npm run build
pm2 restart ai-server
```

Confirm with `git log -1` on the server — it should show `b4500aa` or later before retesting.

## Why we're confident it's not mobile

`src/modules/voice/voice.gateway.ts` — both the mobile app and the web app send the same `text:send` Socket.IO event, handled by the same `processPrompt()` function:

```ts
@SubscribeMessage('text:send')
...
await this.processPrompt(client, session, text, 'text');
```

There is no client-type check, no user-agent branch, and no separate mobile endpoint anywhere in the document-generation path. Whatever the backend does for one client, it does for the other.

## What was actually broken, and the fix history

### ✅ Fixed — The AI was told about a tool it didn't always have (`e05d40f`)

The system prompt unconditionally told Claude it had a `generate_document` tool, even on requests where that tool wasn't actually registered with the Anthropic API. Claude would try to "call" it anyway, and — having no real mechanism to do so — narrate a fake tool-call as plain chat text. Also added a streaming filter so that narration, if it ever recurs, never reaches the live chat feed unfiltered.

Files: `voice.gateway.ts` · `claude.service.ts` · `tool-call-stream-filter.util.ts`

### ✅ Fixed — A single-message keyword check couldn't see multi-turn requests (`b4500aa`)

The first fix still gated the tool behind a regex checking the latest message for words like "create," "generate," "document." Real requests build up over several turns — "I want a strategy for X" → clarifying questions → "in document format" — and no single message in that sequence needs to contain a trigger word. Replaced the regex gate entirely: the tool is now registered on every authenticated turn, and Claude's own tool-use judgment decides when to call it — which is what tool-calling is for.

Files: `voice.gateway.ts`

### ⏳ Pending commit — A successful document could still show a "didn't catch that" message

Separate, smaller gap: if a document generated successfully but Claude's own follow-up confirmation text happened to come back empty, the app showed a generic "I didn't quite catch that — could you rephrase?" — directly contradicting the `document:ready` event that had already fired with a real download link. The fallback now checks whether a document was generated this turn and, if so, shows a real "your document is ready" message with the link instead.

Files: `voice.gateway.ts`

## Retest checklist

1. Confirm the server's checked-out commit is `b4500aa` or later (`git log -1`).
2. Confirm the app was rebuilt and the process restarted — not just migrated.
3. Retest from mobile with the exact phrase that failed before: *"Create a document explaining how to use internet."*
4. Expect: `document:generating` → `document:ready` events, plus a chat confirmation with a working download link.
5. If it still fails after a confirmed rebuild+restart, that's the point to open a genuinely new investigation — capture the socket event log from that session and share it back.

---

Prepared from direct inspection of `cognix-api` — not from the mobile client, which was not found to differ from web in this path.

- `src/modules/voice/voice.gateway.ts`
- `src/modules/voice/services/claude.service.ts`
- `src/modules/voice/utils/tool-call-stream-filter.util.ts`
