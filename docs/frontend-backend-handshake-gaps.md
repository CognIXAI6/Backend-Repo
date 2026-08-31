# Frontend ↔ Backend Handshake Gaps: "Could not clean up empty conversations" / "Something went wrong on our end"

**Status:** Investigation only — nothing in this document has been fixed.
**Repos examined:** `cognix-api` (backend), `CognixAI` (frontend monorepo — `apps/mobile`, `packages/api`, `packages/store`).
**Symptom:** On opening the app, two toasts appear together:
1. *"Could not clean up empty conversations. You can continue using CognixAI."*
2. *"Something went wrong on our end. Please try again."*

## 1. Where each toast actually comes from

### Toast 1 — "Could not clean up empty conversations..."

This is **not** a generic error handler — it's a bespoke `.catch()` in `apps/mobile/src/screens/HomeChat.tsx`:

```ts
// HomeChat.tsx:1721-1743
const ensureConversationBootstrapReady = useCallback(() => {
  if (!token || isGuest) return Promise.resolve();
  ...
  promise: ensureEmptyConversationsPurged(scope)
    .then(() => undefined)
    .catch((error) => {
      devLog("warn", "Empty conversation cleanup failed", error);
      showToast("Could not clean up empty conversations. You can continue using CognixAI.", "info");
    }),
  ...
}, [authBootstrapId, ensureEmptyConversationsPurged, isGuest, showToast, token]);

useEffect(() => {
  void ensureConversationBootstrapReady();
}, [ensureConversationBootstrapReady]);
```

This fires `DELETE /conversations/empty` (`purgeEmptyConversations` in `packages/api/src/conversations.ts`) **every time the Home screen mounts with a fresh `authBootstrapId`** — i.e. on every cold app open for an authenticated (non-guest) user, not on a schedule or only-when-needed basis.

Notably, `packages/api/src/client.ts`'s shared axios error interceptor **already** special-cases this exact endpoint to suppress its own toast/logging noise:

```ts
// client.ts
const isBestEffortConversationCleanup = requestPath.includes("/conversations/empty");
...
if (isBestEffortConversationCleanup) {
  return Promise.reject(error); // no toast from here
}
```

So there are **two layers deliberately built to treat this call as "best effort"**, yet the second layer (`HomeChat.tsx`) still surfaces a user-visible toast on every failure. That's a design inconsistency: if this is truly best-effort maintenance, failing silently (or logging only) would match the intent expressed in `client.ts`'s own comment ("Best-effort background maintenance should remain observable without triggering the... error overlay"). As implemented, the user sees a toast for a purely internal janitorial task that has nothing to do with anything they did.

### Toast 2 — "Something went wrong on our end. Please try again."

This string is hardcoded in `client.ts`'s shared response interceptor, for **any** non-cleanup request that returns a 5xx (excluding 503, which gets a different message):

```ts
// client.ts
} else if (status === 503 || status >= 500) {
  const now = Date.now();
  if (now - lastServerToastAt > 4_000) {
    lastServerToastAt = now;
    showToast(
      status === 503 ? "The server is starting up. Please wait a moment and try again."
                     : "Something went wrong on our end. Please try again.",
      "error",
    );
  }
}
```

Because `isBestEffortConversationCleanup` requests are returned early and never reach this branch, **toast 2 cannot be coming from the same `/conversations/empty` call as toast 1.** It must be a *different* request that failed with a 500 around the same time. This is the key clue: the two toasts appearing together points to a bootstrap-time pattern, not a single broken endpoint.

## 2. The bootstrap stampede

The instant `token` becomes truthy (app open with a persisted session, or right after login), a large number of independent React Query hooks become `enabled` and fire concurrently, with no coordination between them:

- `useEnsureEmptyConversationsPurged` → `DELETE /conversations/empty` (fires from `HomeChat.tsx`'s effect)
- `useProfile` (`packages/api/src/useProfile.ts`)
- `useOnboarding` (`packages/api/src/useOnboarding.ts`) — includes a `GET /onboarding/status` call that `client.ts` explicitly special-cases (`isOnboardingStatusRequest`) to suppress the *network-error* toast for, but **not** the 5xx toast
- `usePayment` (`packages/api/src/usePayment.ts`)
- `useUser` (`packages/api/src/useUser.ts`)
- `useSpeakers`, `useVoice`, `useDocuments`, and `useConversations`/`useAllConversations` (all token-gated similarly)

None of these are staggered, deduplicated against a "is the backend actually up yet" check, or run behind a shared readiness gate. If the backend is slow to respond to the *first* wave of requests after a period of inactivity, several of these can fail simultaneously — which is consistent with seeing both the cleanup-specific toast and the generic 500 toast on the same screen at the same moment.

**Gap:** there is no single "app bootstrap" request/gate that the rest of the app waits on. Bootstrap correctness is emergent from ~7 independently-triggered queries racing the network.

## 3. Backend hosting is very likely the trigger: Render cold starts

- The frontend's production API base URL is hardcoded: `packages/api/src/config.ts` → `DEFAULT_API_BASE_URL = "https://prod-apis.cognixai.ca/api/v1"`.
- Earlier in this investigation (voice-connection debugging session), the raw WebSocket URL for the same backend was observed as `wss://cognix-api-xrdi.onrender.com/socket.io/...` — confirming `prod-apis.cognixai.ca` is a custom domain in front of a **Render** web service.
- `cognix-api`'s `ecosystem.config.js` runs a single PM2 fork instance (`instances: 1`) — nothing here indicates the Render service tier, but Render's free/starter web services are well known to spin down after ~15 minutes idle and take 30–60+ seconds to cold-start the next request.
- There is no `render.yaml` in the `cognix-api` repo, so the service's plan/scaling/health-check configuration isn't tracked as code and can't be verified from the repo alone — this itself is a gap (infra config isn't reviewable or reproducible from source control).

If the backend is cold-starting, the first burst of concurrent bootstrap requests (section 2) would very plausibly time out or 500 together — exactly matching both toasts appearing at once. This can't be confirmed from the repos alone (would need Render dashboard access or request logs from the moment of the screenshot), but it's the most evidence-backed explanation available.

## 4. `DELETE` requests don't get the long write timeout

`client.ts`'s per-request timeout interceptor only upgrades `POST`/`PUT`/`PATCH` to the 45s `WRITE_TIMEOUT_MS`:

```ts
// client.ts
const method = (config.method ?? "get").toLowerCase();
if (["post", "put", "patch"].includes(method)) {
  config.timeout = WRITE_TIMEOUT_MS;
}
```

`DELETE` is missing from this list. Every `DELETE` call in the app — including `DELETE /conversations/empty`, `DELETE /conversations/:id`, `DELETE /resources/:id` — silently falls back to the 15s `READ_TIMEOUT_MS`. A `DELETE` is not guaranteed to be cheaper or faster than a `PATCH`/`POST`, and in this specific case `purgeEmptyConversations` does a full table scan-ish delete (see section 6) — it's arguably one of the *more* expensive writes in the app, yet has the shortest timeout budget of any mutating request. Under a cold start or any backend slowness, this is the request most likely to time out first.

## 5. Two independently-stacked axios interceptors with implicit ordering

There are two separate places that call `api.interceptors.response.use(...)` on the same shared `axios` instance:

- `client.ts` — registered at module import time (toast/logging/retry logic)
- `refresh.ts` — registered explicitly later via `setupInterceptors()` (401/403 token-refresh-and-retry logic)

Axios response interceptors execute in the order they were registered, so `client.ts`'s handler always runs *before* `refresh.ts`'s handler for any given error. This happens to work for the 401 case today because `client.ts` explicitly no-ops on `status === 401` with a comment acknowledging `refresh.ts` handles it ("Handled by the auth refresh interceptor upstream") — but that's a comment-level contract between two files that don't reference each other, not an enforced one. `client.ts`'s own GET-retry logic (`shouldRetry`/`retryDelay`) also runs *before* `refresh.ts` ever sees the error, meaning a GET request that both needs a token refresh **and** happens to also qualify for a network-error retry will be retried up to twice with the **stale** token before `refresh.ts` gets a chance to refresh it.

**Gap:** interceptor responsibilities (toast/retry vs. auth-refresh) are split across two files with no shared ordering guarantee beyond "whichever one happens to import/register first" — fragile to future refactors.

## 6. `purgeEmptyConversations` is a synchronous, per-login DB write, not a scheduled job

`purgeEmptyConversations` (`src/modules/voice/services/conversation.service.ts`) runs a live `DELETE` against the `conversations` table, scoped by `user_id` + `total_messages = 0`, on **every single authenticated app open** (triggered from the frontend's per-`authBootstrapId` effect, not from any server-side schedule). This means:

- Every user's app-open path includes a write query against the primary conversations table, with no caching/backoff if it was already run recently for that session beyond the client-side `authBootstrapId` dedupe (which itself resets on every fresh login/token issuance, not e.g. once per day).
- The query filters on `user_id` (indexed) + `total_messages` + `deleted_at` (neither indexed together or individually — see `20260124000020_create_conversations_table.ts`), plus (after this session's separate fix) a `NOT EXISTS` correlated subquery against `resource_conversations` (indexed on `conversation_id`). At small scale this is fine; at scale, for a user with a large conversation history, this is a non-trivial write on every login.
- There is no server-side equivalent (cron/scheduled job) — cleanup depends entirely on the client remembering to call it, meaning it silently never runs for guest sessions, and never runs at all if every client build happens to fail this specific call (which, per this investigation, is plausible during backend slowness).

**Gap:** a maintenance/cleanup operation is implemented as a blocking, per-session, client-triggered network call instead of an idempotent server-side scheduled task — it sits directly on the critical path of every app open for no user-facing benefit, and its failure mode is a user-visible toast for something the user never asked for.

## 7. Data-loss risk if the backend hasn't picked up this session's fix yet

Separately from this investigation, a real bug was found and fixed (uncommitted, not confirmed deployed) earlier in this working session: `purgeEmptyConversations` was hard-deleting conversations with `total_messages = 0` **even if a resource had already been tagged to that conversation** via `POST /resources` with `conversationIds` (that flow never increments `total_messages`). Because `resource_conversations.conversation_id`, `conversation_messages.conversation_id`, `conversation_transcript_segments.conversation_id`, `conversation_images.conversation_id`, and `conversation_participants.conversation_id` all `CASCADE` on delete, a wrongly-purged conversation silently takes its tagged resources, images, transcript segments, and participant records with it.

**If the currently-deployed backend predates this fix**, then part of what users are experiencing may not be "cleanup failed" (toast 1) but the opposite and worse case — "cleanup succeeded and quietly deleted something it shouldn't have." This is worth confirming against the deployed commit before assuming toast 1 is the whole story.

## 8. Suggested next steps for confirming root cause (not fixes)

- Check Render's dashboard / logs for the service backing `prod-apis.cognixai.ca` around the time of the screenshot — specifically for a cold-start spin-up event and for which endpoint(s) returned 5xx in that window.
- Check `client.ts`'s `logger.error` output / Sentry breadcrumbs (if wired to a remote sink) for the exact URL that triggered toast 2 — the interceptor already logs `error.config?.url` for every non-cleanup 5xx.
- Confirm which commit is actually deployed to `prod-apis.cognixai.ca` vs. the fixes made in this local working tree (`purgeEmptyConversations` resource-tagging guard, Deepgram keepalive/crash-race fixes) — none of today's backend changes have been committed or deployed yet.
