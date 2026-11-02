# Upgrade / Plan-Gating Messages

**Status:** Backend implemented and tested.
**Audience:** Frontend engineers (web/iOS/Android).

When a user tries a feature their plan doesn't include (not "ran out of quota this month" — actually not included at all), the backend now always uses this exact message:

> **"Upgrade your account to use this feature."**

This is a wording/consistency change plus one real gap fix (video analysis had no gate at all before). There are two spots the client needs to handle — one may already be wired up, one is new.

## 1. Voice-gateway socket — `entitlement:blocked` (likely needs confirming, not new)

Fires on `session:start` when a Free-tier user requests `dual_speaker` or `multiple_speaker` mode. Fires **before** the mic/recording session opens — no audio capture starts, no "ready" event is coming after this.

```json
{
  "reason": "mode_not_permitted",
  "message": "Upgrade your account to use this feature.",
  "mode": "dual_speaker",
  "tier": "free"
}
```

Other `reason` values on the same event (unchanged, still the detailed "used X this month" copy, not the new short message):
- `voice_minutes_exhausted`
- `messages_exhausted`

**Action needed:** confirm the client listens for `entitlement:blocked` specifically (not just the generic `error` event) and shows `message` as an upgrade prompt. If this was never wired up, today the mic UI just sits there with nothing visibly happening when a Free user picks dual/group mode.

## 2. REST — `POST /voice/analyse-video` can now return 403 (new — this endpoint never did this before)

This endpoint had no plan check at all until now — any signed-in user could analyze video regardless of tier. It now returns a 403 in two cases:

Plan doesn't include video analysis (e.g. Free):
```json
{
  "statusCode": 403,
  "message": ["Upgrade your account to use this feature."],
  "correlationId": "…"
}
```

Plan includes it but the monthly cap is hit:
```json
{
  "statusCode": 403,
  "message": ["You've used all 2 video analyses included in your plan this month. Upgrade for more."],
  "correlationId": "…"
}
```

`message` is always an array (standard shape from the global exception filter) — read `message[0]`.

**Action needed:** handle a 403 from this call and show `message[0]` as an upgrade prompt instead of a generic failure toast. This is a brand-new failure mode for a call that previously only ever succeeded or 400'd on a bad file.

## 3. In-chat document requests — no new handling, just FYI

If a Free-tier user asks the AI (via chat or voice) to generate a document, the AI's own reply text is now exactly `"Upgrade your account to use this feature."` — that's ordinary assistant message content, not an error or event. Nothing to wire up here; it renders like any other AI reply already does.

## Optional: avoid the round-trip entirely

`GET /payment/my-plan` already returns the signed-in user's tier, full entitlements (including `allowedVoiceModes`, document/video/message caps), and this month's usage against each. If you want to gray out dual/group mode or the video-analysis button for Free users up front instead of letting them tap it and get blocked, that endpoint has everything needed to do it client-side. Not required — the gates above work fine on their own — just saves a round-trip.

## Not changed

- Quota-*exhausted* messages ("you've used all X messages/voice minutes/documents this month") — unchanged, still as before.
- No new socket events added. `entitlement:blocked` already existed; only the message text for the mode-exclusion case changed.
