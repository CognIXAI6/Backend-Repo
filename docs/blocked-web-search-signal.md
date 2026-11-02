# Blocked Web Search Signal

**Status:** Backend implemented and tested. Frontend wiring not yet done.
**Audience:** Frontend engineers (web, iOS, Android).

This is the response to the "report when an automatic web search is blocked by the user's plan" request. It adds one new socket event: `feature:unavailable`.

## The problem this solves

Web search runs automatically as part of a normal AI reply — there's no search button, Claude decides on its own whether a question needs live information. When a user's plan or monthly allowance blocks that search, the AI still answers (from training knowledge), but until now nothing told the client that live search was skipped. The user could get a stale or incomplete answer with no indication why.

## How "a search was needed" is actually decided

Not a keyword match on the user's message, and not a flat "quota is exhausted" check. The `web_search` tool stays registered for every eligible turn regardless of quota — Claude's own tool-use judgment, with full conversation context, decides whether to call it. Only when Claude *actually attempts* a call is it intercepted. If Claude never tries to search, nothing fires — a normal "hello" or an off-topic-quota-exhausted account produces zero noise.

## The event

Socket namespace `/voice`, event `feature:unavailable`:

```json
{
  "feature": "web_search",
  "reason": "quota_exhausted",
  "message": "You've used all 10 web searches included in your plan this month. Upgrade for more.",
  "used": 10,
  "limit": 10,
  "conversationId": "0f6e1a2e-...",
  "turnId": "9c3b7d41-..."
}
```

| Field | Meaning |
| --- | --- |
| `feature` | Always `"web_search"` for now — the shape is generic enough to extend to other AI-decided features later if needed. |
| `reason` | `"quota_exhausted"` (plan includes some monthly allowance, it's used up) or `"plan_excluded"` (plan's allowance is 0 — not currently true for any live tier, but handled). |
| `message` | Ready-to-show text — same phrasing/tone as the other upgrade-prompt messages already in the app (see `docs/upgrade-gating-messages.md`). |
| `used` / `limit` | This month's web-search usage at the moment of the block. Present whenever available. |
| `conversationId` | The conversation this turn belongs to. |
| `turnId` | A fresh id generated per AI turn — use this to associate the signal with the specific response it affected, since it can arrive mid-stream, before that assistant message has an id of its own. |

## When it fires, and what it does NOT affect

- Fires **mid-turn**, potentially before `ai:done` for the same turn. Don't treat it as replacing or blocking the normal response flow.
- The AI's response still completes normally — `ai:token`/`ai:done` behave exactly as they always do. This event is additive information, not an error.
- **Deliberately not routed through `entitlement:blocked`.** That event's existing handler is understood to stop mic capture / treat it as a session block. A blocked search is not a failure of the turn — don't wire this into the same handler, or you'll cut off the mic over a perfectly normal reply.
- Not emitted for `dual_speaker` or `multiple_speaker` voice modes, or for the durable `POST /chat/messages` REST path — web search isn't offered on those paths at all today (pre-existing, unrelated to this change), so there's nothing to signal there.

## Important: this is live-socket-only, not durable

Unlike `summary_status` (which you can poll via `GET /conversations/:id` even after reconnecting), **there is no persisted record of a blocked search** right now. If the client is disconnected, backgrounded, or simply not listening at the moment this fires, the signal is gone — same tradeoff as the existing `document:generating`/`document:ready` events on a live connection.

If you need this to survive a reconnect or an app restart — e.g. show "live search wasn't available for this answer" when the user reopens a conversation later — that needs its own persistence (a column alongside the assistant message, similar to how `summary_status` was added for conversations) and is a separate piece of backend work, not built yet. Flag if you need it; happy to scope it once we know the actual requirement (e.g. is "in the moment" good enough, or does it need to show up in history too).

## What to wire up

1. Listen for `feature:unavailable` on the `/voice` socket, separately from `entitlement:blocked` and `error`.
2. When `feature === 'web_search'`, show `message` in context — e.g. a small inline note on the AI's response for that `turnId`, not a modal or anything that interrupts the conversation.
3. Do **not** stop the mic, end the session, or mark the response as failed when this arrives.
4. If you need the "survives reconnect / shows in history" behavior described above, let us know — not available yet.
