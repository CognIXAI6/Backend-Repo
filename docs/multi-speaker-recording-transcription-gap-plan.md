# Multi-Speaker Recording and Transcription Gap Audit

Date: 2026-07-02

Scope: Backend recording, transcription, diarization, speaker identification, persistence, and frontend parity for multi-speaker web/mobile recording.

Repos reviewed:

- Backend: `/Users/hgh/Backend-Repo`
- Frontend web/mobile: `/Users/hgh/CognixAI`

Current verdict: partially implemented, not ready for frontend parity as a stable contract.

The backend now contains the core primitives for multi-speaker recording, including `multiple_speaker` mode, Deepgram diarization, `Guest 1`/`Guest 2` fallback labels, a transcript segment table, manual correction events, and voice identification scaffolding. However, the implementation still has correctness gaps in stop/flush behavior, segment persistence and reload, speaker ID mapping, correction reliability, tests, and frontend contract support.

## Definition of Done

Multi-speaker support should be considered complete only when all of the following are true:

1. A user can start a session with `mode: "multiple_speaker"`.
2. Deepgram diarization separates unknown speakers automatically.
3. Unknown speakers receive stable session labels such as `Guest 1`, `Guest 2`, `Guest 3`.
4. Registered speakers can be matched automatically when voice profiles exist.
5. Unregistered speakers remain visible as guest speakers without blocking the session.
6. Users can manually rename a guest or correct a speaker label.
7. Manual corrections persist and do not falsely report success.
8. `audio:stop`, `utteranceEnd`, and `session:end` all flush pending multi-speaker turns correctly.
9. Multi-speaker turns are saved with segment rows and can be reloaded by conversation APIs.
10. The frontend can render live segments and historical segments consistently after refresh.
11. Build, relevant unit tests, and at least one integration-style socket flow pass.

## What Is Already Implemented

### Backend mode and diarization

File: `src/modules/voice/voice.gateway.ts`

Implemented:

- `RealtimeMode` includes `multiple_speaker`.
- `session:start` accepts `mode`, `speakerRoster`, `expectedSpeakerCount`, and `audioSource`.
- Multi-speaker mode enables Deepgram diarization and meeting mode.
- `session:ready` returns `mode`, `isMultiSpeaker`, and roster speakers when present.

### Anonymous speaker labels

File: `src/modules/voice/voice.gateway.ts`

Implemented:

- `getAnonymousSpeakerLabel` maps Deepgram speaker IDs to stable labels in the active session.
- Unknown speakers are labeled `Guest 1`, `Guest 2`, etc.
- This works even when speakers are not registered or assigned names.

Important limitation:

- The labels are currently session-local unless persisted segment rows are correctly loaded and returned later.

### Segment persistence table

File: `src/database/migrations/20260702000029_create_conversation_transcript_segments.ts`

Implemented:

- `conversation_transcript_segments` table exists.
- It stores `conversation_id`, `message_id`, `speaker_id`, `deepgram_speaker_id`, `speaker_label`, `transcript`, timestamps, confidence, identification method, and correction state.
- Indexes exist for conversation and speaker lookup.

### Voice identification reliability primitives

File: `src/modules/voice/services/voice-verification.service.ts`

Implemented:

- External voice verification calls have a timeout.
- A basic circuit breaker opens after repeated failures.
- 1:N identification endpoint wrapper exists.

### Manual speaker correction events

Files:

- `src/modules/voice/voice.gateway.ts`
- `src/modules/voice/services/conversation.service.ts`

Implemented:

- `transcript:correct_speaker`
- `transcript:rename_guest`
- DB update helpers for segment rows.

Important limitation:

- These events can currently emit success even if DB persistence fails.

## Critical Gaps and Exact Implementation Plan

## Gap 1: `audio:stop` Uses The Single-Speaker Path In Multi-Speaker Mode

Severity: P1

Files:

- `src/modules/voice/voice.gateway.ts`

Current behavior:

- `handleAudioStop` reads `session.accumulatedTranscript` and `session.pendingInterimTranscript`.
- It clears single-speaker transcript buffers.
- It always calls `processPrompt(client, session, transcript, "voice")`.
- In multi-speaker mode, this loses structured `segments` and saves the transcript like a normal single-speaker user message.

Why this matters:

- If the user stops recording before the Deepgram `utteranceEnd` debounce fires, the final multi-speaker turn can be saved incorrectly.
- The frontend receives `transcript:confirmed` without `mode: "multiple_speaker"` and without `segments`.
- Historical transcript data becomes inconsistent.

Implementation:

1. Add a helper to flush pending multi-speaker turns.

```ts
private async flushMultiSpeakerTurns(
  client: Socket,
  session: ActiveSession,
  options: { minWords?: number; reason: "utterance_end" | "audio_stop" | "session_end" },
): Promise<boolean> {
  if (!session.isMultiSpeaker) return false;
  if (session.isProcessingAI) {
    client.emit("ai:skipped", { reason: "already_processing" });
    return false;
  }

  const turns = [...session.pendingMultiSpeakerTurns];
  if (turns.length === 0) {
    client.emit("ai:skipped", { reason: "empty_transcript" });
    return false;
  }

  const combinedWords = this.countTurnWords(turns);
  const minWords = options.minWords ?? 8;
  if (combinedWords < minWords) {
    client.emit("ai:skipped", {
      reason: "too_short",
      mode: "multiple_speaker",
      transcript: turns.map((t) => t.text).join(" "),
      segments: turns,
    });
    return false;
  }

  session.pendingMultiSpeakerTurns = [];
  session.accumulatedTranscript = "";
  session.transcriptConfidences = [];
  client.emit("transcript:update", {
    mode: "multiple_speaker",
    transcript: "",
    isFinal: true,
    cleared: true,
  });

  await this.processMultiSpeakerPrompt(client, session, turns);
  return true;
}
```

2. Add a small reusable word counter.

```ts
private countTurnWords(turns: MultiSpeakerTurn[]): number {
  return turns
    .map((t) => t.text)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}
```

3. Update `handleAudioStop`.

```ts
@SubscribeMessage("audio:stop")
async handleAudioStop(@ConnectedSocket() client: Socket): Promise<void> {
  const session = this.sessions.get(client.id);
  if (!session) return;

  if (session.isMultiSpeaker) {
    await this.flushMultiSpeakerTurns(client, session, {
      reason: "audio_stop",
      minWords: 1,
    });
    return;
  }

  // Existing single/dual behavior continues here.
}
```

4. Consider `session:end` behavior.

Before cleanup, optionally flush pending multi-speaker turns:

```ts
if (session?.isMultiSpeaker && session.pendingMultiSpeakerTurns.length > 0) {
  await this.flushMultiSpeakerTurns(client, session, {
    reason: "session_end",
    minWords: 1,
  });
}
```

Acceptance criteria:

- `audio:stop` in multi-speaker mode emits `transcript:confirmed` with `mode: "multiple_speaker"` and `segments`.
- No multi-speaker stop path calls `processPrompt`.
- Pending segments are not lost when stop is tapped quickly.

## Gap 2: Short Multi-Speaker Turns Are Dropped Before They Can Accumulate

Severity: P1

File:

- `src/modules/voice/voice.gateway.ts`

Current behavior:

```ts
const turns = session.pendingMultiSpeakerTurns.splice(0);
const combinedWords = ...
if (combinedWords < 8) return;
```

Problem:

- `splice(0)` clears the queue before the word threshold check.
- If the turn is short, it is discarded permanently.
- Later speech cannot combine with it.

Implementation:

Replace the utterance-end multi-speaker block with:

```ts
if (session.isMultiSpeaker) {
  if (session.pendingMultiSpeakerTurns.length === 0) return;

  const turns = [...session.pendingMultiSpeakerTurns];
  const combinedWords = this.countTurnWords(turns);

  if (combinedWords < 8) return;

  session.pendingMultiSpeakerTurns = [];
  session.accumulatedTranscript = "";
  client.emit("transcript:update", {
    mode: "multiple_speaker",
    transcript: "",
    isFinal: true,
    cleared: true,
  });

  await this.processMultiSpeakerPrompt(client, session, turns);
  return;
}
```

Preferred implementation:

- Use the `flushMultiSpeakerTurns` helper from Gap 1.

```ts
if (session.isMultiSpeaker) {
  await this.flushMultiSpeakerTurns(client, session, {
    reason: "utterance_end",
    minWords: 8,
  });
  return;
}
```

Acceptance criteria:

- A sequence of short multi-speaker turns eventually triggers AI once combined words exceed threshold.
- No pending turn is discarded only because it was initially short.

## Gap 3: Saved Conversation APIs Do Not Return Transcript Segments

Severity: P1

Files:

- `src/modules/voice/services/conversation.service.ts`
- `src/modules/conversations/conversations.controller.ts`

Current behavior:

- Segments are written to `conversation_transcript_segments`.
- `getConversation` returns only `conversation_messages`.
- `getConversationMessages` returns only `conversation_messages`.
- There is no endpoint to load `conversation_transcript_segments`.

Product impact:

- Live multi-speaker transcripts can appear during recording.
- After refresh, reopen, or cross-device load, the speaker-attributed transcript is missing.
- Frontend cannot build a reliable history view.

Implementation:

1. Add a transcript segment type.

```ts
export interface ConversationTranscriptSegment {
  id: string;
  conversation_id: string;
  message_id: string | null;
  speaker_id: string | null;
  deepgram_speaker_id: number | null;
  speaker_label: string;
  transcript: string;
  start_ms: number | null;
  end_ms: number | null;
  confidence: number | null;
  identification_method: "voice_id" | "manual" | "diarization" | "unknown";
  is_corrected: boolean;
  created_at: Date;
}
```

2. Add `getTranscriptSegments`.

```ts
async getTranscriptSegments(
  conversationId: string,
  userId: string,
): Promise<ConversationTranscriptSegment[]> {
  await this.assertOwnership(conversationId, userId);

  return this.knex("conversation_transcript_segments")
    .where("conversation_id", conversationId)
    .orderBy([
      { column: "created_at", order: "asc" },
      { column: "start_ms", order: "asc", nulls: "last" },
    ])
    .select("*");
}
```

3. Update `getConversation`.

```ts
async getConversation(
  conversationId: string,
  userId: string,
): Promise<Conversation & {
  messages: ConversationMessage[];
  transcriptSegments: ConversationTranscriptSegment[];
}> {
  const conversation = await this.knex("conversations")
    .where({ id: conversationId, user_id: userId })
    .whereNull("deleted_at")
    .first();

  if (!conversation) throw new NotFoundException("Conversation not found");

  const [messages, transcriptSegments] = await Promise.all([
    this.knex("conversation_messages")
      .where("conversation_id", conversationId)
      .orderBy("created_at", "asc")
      .select("*"),
    this.knex("conversation_transcript_segments")
      .where("conversation_id", conversationId)
      .orderBy([
        { column: "created_at", order: "asc" },
        { column: "start_ms", order: "asc", nulls: "last" },
      ])
      .select("*"),
  ]);

  return { ...conversation, messages, transcriptSegments };
}
```

4. Add a dedicated controller endpoint.

```ts
@Get(":id/transcript-segments")
async getTranscriptSegments(
  @CurrentUser("id") userId: string,
  @Param("id") conversationId: string,
) {
  return this.conversationService.getTranscriptSegments(conversationId, userId);
}
```

Response shape:

```json
[
  {
    "id": "uuid",
    "conversation_id": "uuid",
    "message_id": "uuid|null",
    "speaker_id": "uuid|null",
    "deepgram_speaker_id": 0,
    "speaker_label": "Guest 1",
    "transcript": "I think we should start with the timeline.",
    "start_ms": 1200,
    "end_ms": 4200,
    "confidence": "0.9275",
    "identification_method": "diarization",
    "is_corrected": false,
    "created_at": "2026-07-02T10:00:00.000Z"
  }
]
```

Acceptance criteria:

- `GET /conversations/:id` includes `transcriptSegments`.
- `GET /conversations/:id/transcript-segments` returns the segments independently.
- Frontend can reconstruct historical multi-speaker transcripts after reload.

## Gap 4: Account-Wide Voice Match Stores External Voice ID As Local `speaker_id`

Severity: P1

File:

- `src/modules/voice/voice.gateway.ts`

Current behavior:

When identification matches a roster entry:

```ts
resolvedSpeakerId = matchedRosterEntry.speakerId;
```

When identification matches account-wide fallback:

```ts
resolvedSpeakerId = result.speakerId;
```

Problem:

- `result.speakerId` is the external voice verification speaker ID.
- `conversation_transcript_segments.speaker_id` references local `speakers.id`.
- This can break inserts or corrupt attribution.

Implementation:

1. Build an account-wide voice ID map when falling back.

```ts
let accountSpeakerByVoiceId = new Map<string, { id: string; name: string; voice_speaker_id: string | null }>();

if (candidateIds.length === 0) {
  const allSpeakers = await this.speakersService.getUserSpeakers(session.userId);
  accountSpeakerByVoiceId = new Map(
    allSpeakers
      .filter((s) => s.voice_speaker_id)
      .map((s) => [s.voice_speaker_id!, s]),
  );

  for (const s of allSpeakers) {
    if (s.voice_speaker_id) candidateIds.push(s.voice_speaker_id);
  }
}
```

2. Resolve fallback result through the map.

```ts
const accountSpeaker = result.speakerId
  ? accountSpeakerByVoiceId.get(result.speakerId)
  : undefined;

if (matchedRosterEntry) {
  resolvedName = matchedRosterEntry.displayName;
  resolvedSpeakerId = matchedRosterEntry.speakerId;
} else if (accountSpeaker) {
  resolvedName = accountSpeaker.name ?? result.speakerName ?? anonymousLabel;
  resolvedSpeakerId = accountSpeaker.id;
} else {
  resolvedName = result.speakerName ?? anonymousLabel;
  resolvedSpeakerId = null;
}
```

3. Keep `voiceSpeakerId` separate.

```ts
const resolved: ResolvedSpeaker = {
  speakerId: resolvedSpeakerId,
  label: resolvedName,
  voiceSpeakerId: result.identified ? result.speakerId : null,
  method,
  confidence: result.similarityScore,
};
```

Acceptance criteria:

- `speaker_id` always stores local `speakers.id` or `null`.
- `voiceSpeakerId` stores the external voice ID.
- Segment insert does not fail FK validation after account-wide match.

## Gap 5: Speaker Correction And Guest Rename Emit Success Even If DB Update Fails

Severity: P1

File:

- `src/modules/voice/voice.gateway.ts`

Current behavior:

- DB update is wrapped in `try/catch`.
- Errors are logged.
- Success event is emitted anyway.

Problem:

- Frontend can show a successful correction that is not persisted.
- User trust is damaged when refresh reverts the correction.

Implementation:

1. In `handleCorrectSpeaker`, return an error if persistence fails.

```ts
try {
  await this.conversationService.correctTranscriptSpeaker(...);
} catch (err) {
  this.logger.warn(`[${client.id}] correctTranscriptSpeaker DB error: ${(err as Error).message}`);
  this.emitError(client, "SPEAKER_CORRECTION_FAILED", "Failed to persist speaker correction", {
    clientMessage: "Could not save the speaker correction. Please try again.",
    severity: "warn",
  });
  return;
}
```

2. In `handleRenameGuest`, return an error if persistence fails.

```ts
try {
  await this.conversationService.renameAnonymousSpeaker(...);
} catch (err) {
  this.logger.warn(`[${client.id}] renameAnonymousSpeaker DB error: ${(err as Error).message}`);
  this.emitError(client, "GUEST_RENAME_FAILED", "Failed to persist guest rename", {
    clientMessage: "Could not save the guest name. Please try again.",
    severity: "warn",
  });
  return;
}
```

3. Optionally include `persisted: true` on success.

```ts
client.emit("transcript:speaker_corrected", {
  ...,
  persisted: true,
});
```

Acceptance criteria:

- Frontend never receives success when DB update failed.
- Error event is specific and recoverable.

## Gap 6: Automatic Voice Identification Does Not Retroactively Update Saved Segments

Severity: P2

Files:

- `src/modules/voice/voice.gateway.ts`
- `src/modules/voice/services/conversation.service.ts`

Current behavior:

- If speaker identification completes after some turns were saved as `Guest 1`, in-memory `resolvedSpeakers` is updated.
- Existing DB rows remain `Guest 1`.

Implementation:

1. Add a service method.

```ts
async updateTranscriptSpeakerByDeepgramId(input: {
  conversationId: string;
  deepgramSpeakerId: number;
  speakerId: string | null;
  speakerLabel: string;
  identificationMethod: "voice_id" | "manual" | "diarization" | "unknown";
}): Promise<number> {
  return this.knex("conversation_transcript_segments")
    .where("conversation_id", input.conversationId)
    .andWhere("deepgram_speaker_id", input.deepgramSpeakerId)
    .update({
      speaker_id: input.speakerId,
      speaker_label: input.speakerLabel,
      identification_method: input.identificationMethod,
    });
}
```

2. Call it after successful voice ID.

```ts
if (method === "voice_id") {
  await this.conversationService.updateTranscriptSpeakerByDeepgramId({
    conversationId: session.conversationId,
    deepgramSpeakerId,
    speakerId: resolvedSpeakerId,
    speakerLabel: resolvedName,
    identificationMethod: "voice_id",
  });
}
```

3. Emit enough payload for frontend to update existing live messages.

```ts
client.emit("speaker:identified", {
  deepgramSpeakerId,
  speakerId: resolvedSpeakerId,
  previousLabel: anonymousLabel,
  speakerLabel: resolvedName,
  method,
  persisted: method === "voice_id",
  similarityScore: result.similarityScore,
});
```

Acceptance criteria:

- Existing saved segments change from `Guest N` to the matched speaker after voice ID succeeds.
- Frontend can update current in-memory transcript labels without requiring refresh.

## Gap 7: Multi-Speaker Transcript Builder Drops Final Transcript If `words` Are Missing

Severity: P2

File:

- `src/modules/voice/voice.gateway.ts`

Current behavior:

- `buildMultiSpeakerTurns` only receives `words`.
- If Deepgram returns `result.transcript` but no `words`, `turns` is empty.

Implementation:

1. Change helper signature.

```ts
private buildMultiSpeakerTurns(
  session: ActiveSession,
  words: TranscriptWord[],
  confidence: number,
  fallbackTranscript?: string,
): MultiSpeakerTurn[] {
  ...
}
```

2. Add fallback at the end.

```ts
if (turns.length === 0 && fallbackTranscript?.trim()) {
  const deepgramSpeakerId = session.currentDominantSpeaker ?? 0;
  const identity = this.resolveSpeakerLabel(session, deepgramSpeakerId);
  return [{
    deepgramSpeakerId,
    speakerId: identity.speakerId,
    speakerLabel: identity.speakerLabel,
    text: fallbackTranscript.trim(),
    confidence,
    startMs: null,
    endMs: null,
    identificationMethod: identity.identificationMethod,
  }];
}
```

3. Pass `result.transcript`.

```ts
const turns = this.buildMultiSpeakerTurns(
  session,
  words,
  result.confidence,
  result.transcript,
);
```

Acceptance criteria:

- Final transcript text is not dropped when word-level diarization is absent.
- Fallback segment is clearly marked with diarization/unknown attribution.

## Gap 8: Multi-Speaker Persistence Has No Parent User Message Or `message_id`

Severity: P2

Files:

- `src/modules/voice/voice.gateway.ts`
- `src/modules/voice/services/conversation.service.ts`
- `src/database/migrations/20260702000029_create_conversation_transcript_segments.ts`

Current behavior:

- `processMultiSpeakerPrompt` saves transcript segments.
- It saves only the assistant response as a `conversation_messages` row.
- It does not save a user message representing the multi-speaker exchange.
- Segment rows do not receive `message_id`.

Problem:

- `total_messages` undercounts user turns.
- Conversation history becomes assistant-heavy.
- Frontend cannot group segments under a specific user/voice exchange.

Implementation:

1. Save a parent user message before streaming AI.

```ts
const latestExchange = turns.map((t) => `[${t.speakerLabel}]: ${t.text}`).join("\n");

const userMessageRow = await this.conversationService.saveMessage({
  conversationId: session.conversationId,
  role: "user",
  content: latestExchange,
  transcript: turns.map((t) => t.text).join(" "),
  speakerLabel: "multiple_speakers",
});
```

2. Pass `messageId` into segment saving.

```ts
await this.saveMultiSpeakerTurns(session, turns, userMessageRow.id);
```

3. Update helper signature.

```ts
private async saveMultiSpeakerTurns(
  session: ActiveSession,
  turns: MultiSpeakerTurn[],
  messageId?: string,
): Promise<void> {
  ...
  messageId: messageId ?? null,
}
```

4. Avoid double-saving the user message if retry/error flow restarts.

Preferred structure:

- Save the user message once before `client.emit("ai:start")`.
- Save segments immediately after the user message.
- Save assistant message only in `onDone`.

Acceptance criteria:

- Each multi-speaker AI response has a preceding user message.
- Segment rows for that exchange share the parent `message_id`.
- Conversation history and message count are coherent.

## Gap 9: AI Context Duplicates Latest Multi-Speaker Turns

Severity: P3

File:

- `src/modules/voice/voice.gateway.ts`

Current behavior:

- New turns are pushed into `session.multiSpeakerHistory`.
- `processMultiSpeakerPrompt` builds `conversationContext` from `session.multiSpeakerHistory.slice(-60)`.
- The same turns are also included as `Latest exchange`.

Implementation:

Use history excluding the latest turns:

```ts
const recentHistory = session.multiSpeakerHistory
  .slice(0, Math.max(0, session.multiSpeakerHistory.length - turns.length))
  .slice(-60);
```

Acceptance criteria:

- Latest exchange appears once in the prompt.
- AI context remains concise and less repetitive.

## Gap 10: Correction Scope Semantics Are Too Broad

Severity: P2

Files:

- `src/modules/voice/services/conversation.service.ts`
- `src/database/migrations/20260702000029_create_conversation_transcript_segments.ts`

Current behavior:

- `applyTo: "segment"` updates by `segmentId`.
- `applyTo: "session_speaker"` and `applyTo: "conversation_speaker"` both update all matching `deepgram_speaker_id` rows in the conversation.

Problem:

- A Deepgram speaker ID is session-local, but the schema does not store a recording/session ID.
- If the same conversation has multiple recordings, `deepgram_speaker_id = 0` can refer to different people in different sessions.

Implementation options:

### Option A: Add `recording_session_id`

Best long-term fix.

Migration:

```ts
await knex.schema.alterTable("conversation_transcript_segments", (table) => {
  table.uuid("recording_session_id").nullable();
  table.index(["conversation_id", "recording_session_id", "deepgram_speaker_id"], "idx_segments_session_speaker");
});
```

Session model:

```ts
recordingSessionId: randomUUID()
```

Save segments:

```ts
recordingSessionId: session.recordingSessionId
```

Correction service:

```ts
if (input.applyTo === "session_speaker") {
  query
    .andWhere("recording_session_id", input.recordingSessionId)
    .andWhere("deepgram_speaker_id", input.deepgramSpeakerId);
}
```

### Option B: Restrict current feature

Short-term fix.

- Treat `session_speaker` as active-session in-memory only.
- Treat `conversation_speaker` as DB-wide update.
- Require explicit confirmation in frontend before conversation-wide update.

Acceptance criteria:

- The backend meaningfully distinguishes segment-only, current-session speaker, and whole-conversation speaker correction.
- Frontend copy can explain exactly what will change.

## Gap 11: Frontend Web Does Not Send `multiple_speaker`

Severity: P1 for parity

File:

- `/Users/hgh/CognixAI/apps/web/src/app/(dashboard)/dashboard/page.tsx`

Current behavior:

```ts
type VoiceRealtimeMode = "single" | "dual_speaker";

const realtimeMode =
  speakerModeType === "two" || speakerModeType === "multiple"
    ? "dual_speaker"
    : "single";
```

Problem:

- The web UI has a `multiple` option, but it starts the backend in `dual_speaker` mode.
- The new backend `multiple_speaker` path is never exercised.

Implementation:

1. Update type.

```ts
type VoiceRealtimeMode = "single" | "dual_speaker" | "multiple_speaker";
```

2. Add resolver.

```ts
const resolveRealtimeMode = (mode: SpeakerModeType): VoiceRealtimeMode => {
  if (mode === "two") return "dual_speaker";
  if (mode === "multiple") return "multiple_speaker";
  return "single";
};
```

3. Replace current mode mapping.

```ts
const realtimeMode = resolveRealtimeMode(speakerModeType);
```

4. Update recording confirm.

```ts
const newRealtimeMode = resolveRealtimeMode(config.mode);
```

5. Send optional roster.

If the recording modal allows known participants:

```ts
socket.emit("session:start", {
  mode: realtimeModeRef.current,
  speakerRoster: selectedSpeakers.map((speaker) => ({
    speakerId: speaker.id,
    displayName: speaker.name,
    role: speaker.isOwner ? "owner" : "participant",
  })),
  expectedSpeakerCount,
  audioSource,
  ...
});
```

Acceptance criteria:

- Selecting "multiple" sends `mode: "multiple_speaker"`.
- Selecting "two" still sends `mode: "dual_speaker"`.
- Single speaker behavior is unchanged.

## Gap 12: Frontend Does Not Render Multi-Speaker `segments`

Severity: P1 for parity

Files:

- `/Users/hgh/CognixAI/apps/web/src/app/(dashboard)/dashboard/page.tsx`
- `/Users/hgh/CognixAI/apps/mobile/src/screens/HomeChat.tsx`

Current behavior:

- Frontend listens for `transcript:update` and `transcript:confirmed`.
- It primarily reads `payload.transcript` and a single `speakerLabel`.
- It does not render `payload.segments` as multiple speaker-attributed turns.

Implementation:

1. Define shared frontend types.

```ts
type TranscriptSegment = {
  id?: string;
  deepgramSpeakerId: number | null;
  speakerId?: string | null;
  speakerLabel: string;
  text: string;
  transcript?: string;
  startMs?: number | null;
  endMs?: number | null;
  confidence?: number | null;
  identificationMethod?: "voice_id" | "manual" | "diarization" | "unknown";
};
```

2. Normalize backend segment shape.

```ts
const normalizeSegment = (segment: any): TranscriptSegment => ({
  id: segment.id,
  deepgramSpeakerId: segment.deepgramSpeakerId ?? segment.deepgram_speaker_id ?? null,
  speakerId: segment.speakerId ?? segment.speaker_id ?? null,
  speakerLabel:
    String(segment.speakerLabel ?? segment.speaker_label ?? "Guest").trim() || "Guest",
  text: String(segment.text ?? segment.transcript ?? "").trim(),
  startMs: segment.startMs ?? segment.start_ms ?? null,
  endMs: segment.endMs ?? segment.end_ms ?? null,
  confidence: segment.confidence != null ? Number(segment.confidence) : null,
  identificationMethod:
    segment.identificationMethod ?? segment.identification_method ?? "unknown",
});
```

3. In `transcript:update`, use segments for live preview.

```ts
socket.on("transcript:update", (payload: any) => {
  if (payload?.mode === "multiple_speaker" && Array.isArray(payload?.segments)) {
    setLiveTranscriptSegments(payload.segments.map(normalizeSegment));
    setLiveTranscript("");
    setIsTranscriptLive(true);
    return;
  }

  // Existing single/dual behavior.
});
```

4. In `transcript:confirmed`, append a grouped multi-speaker message.

```ts
socket.on("transcript:confirmed", (payload: any) => {
  if (payload?.mode === "multiple_speaker" && Array.isArray(payload?.segments)) {
    const segments = payload.segments.map(normalizeSegment).filter((s) => s.text);
    appendMessage({
      id: createClientId(),
      type: "multi-speaker-transcript",
      text: segments.map((s) => `[${s.speakerLabel}] ${s.text}`).join("\n"),
      segments,
      source: "voice",
    });
    setLiveTranscriptSegments([]);
    return;
  }

  // Existing behavior.
});
```

5. Render segments as grouped turns.

Design rules:

- Show human-readable speaker labels first.
- Use a stable color per speaker label.
- Show confidence/uncertainty subtly, not as primary text.
- Provide correction/rename actions per segment or per speaker group.
- Handle long names and long transcript text.
- Make controls accessible with buttons and labels.

Acceptance criteria:

- Live transcript displays separate rows for `Guest 1`, `Guest 2`, etc.
- Confirmed transcript preserves speaker turns.
- Existing single/dual UI does not regress.

## Gap 13: Frontend Does Not Handle Speaker Identification And Correction Events For Many Speakers

Severity: P2

Files:

- `/Users/hgh/CognixAI/apps/web/src/app/(dashboard)/dashboard/page.tsx`
- `/Users/hgh/CognixAI/apps/mobile/src/screens/HomeChat.tsx`

Current behavior:

- Web handles `speaker:identified` only if `realtimeModeRef.current === "dual_speaker"`.
- It maps everything to `"speaker-other"`.
- Mobile does not appear to handle `speaker:identified`, `transcript:speaker_corrected`, or `audio:ack`.

Implementation:

1. Keep a map by `deepgramSpeakerId`.

```ts
const speakerIdentityMapRef = useRef<Map<number, {
  speakerId: string | null;
  label: string;
  method: string;
}>>(new Map());
```

2. Handle `speaker:identified` in multi-speaker mode.

```ts
socket.on("speaker:identified", (payload: any) => {
  if (realtimeModeRef.current !== "multiple_speaker") return;

  const deepgramSpeakerId = Number(payload?.deepgramSpeakerId);
  if (!Number.isFinite(deepgramSpeakerId)) return;

  const label = String(payload?.speakerLabel ?? payload?.speakerName ?? "").trim();
  if (!label) return;

  speakerIdentityMapRef.current.set(deepgramSpeakerId, {
    speakerId: payload?.speakerId ?? null,
    label,
    method: String(payload?.method ?? "unknown"),
  });

  updateTranscriptSegmentLabels(deepgramSpeakerId, label, payload?.speakerId ?? null);
});
```

3. Handle manual correction success.

```ts
socket.on("transcript:speaker_corrected", (payload: any) => {
  const deepgramSpeakerId = Number(payload?.deepgramSpeakerId);
  const label = String(payload?.speakerLabel ?? "").trim();
  if (!Number.isFinite(deepgramSpeakerId) || !label) return;

  updateTranscriptSegmentLabels(deepgramSpeakerId, label, payload?.speakerId ?? null);
  showToast("Speaker label updated", "info");
});
```

4. Handle correction errors from backend `error` payloads.

Acceptance criteria:

- Any number of Deepgram speaker IDs can be updated independently.
- `Guest 2` can become `Sarah` without changing `Guest 1`.
- Failed correction shows recoverable error and does not update optimistically unless rollback exists.

## Gap 14: Audio Sequence Acknowledgement Is Backend-Only

Severity: P2

Files:

- `/Users/hgh/CognixAI/apps/web/src/app/(dashboard)/dashboard/page.tsx`
- `/Users/hgh/CognixAI/apps/mobile/src/screens/HomeChat.tsx`

Current backend behavior:

- Backend accepts `audio:chunk` with `sequence`.
- Backend emits `audio:ack`.
- Backend emits `session:degraded` on sequence gaps.

Current frontend behavior:

- Mobile sends chunks without `sequence`.
- Web should be checked and updated similarly.

Implementation:

1. Add a sequence counter per recording.

```ts
const audioSequenceRef = useRef(0);
```

2. Reset on recording start.

```ts
audioSequenceRef.current = 0;
```

3. Send sequence per chunk.

```ts
socket.emit("audio:chunk", {
  chunk,
  sequence: audioSequenceRef.current,
  recordingId: currentRecordingId,
});
audioSequenceRef.current += 1;
```

4. Track ACK.

```ts
socket.on("audio:ack", (payload: any) => {
  lastAckedSequenceRef.current = Number(payload?.sequence);
});
```

Acceptance criteria:

- Backend gap detection can work in production.
- Frontend can surface degraded network state when needed.

## Backend Event Contract

### Start multi-speaker session

Client emits:

```json
{
  "mode": "multiple_speaker",
  "accessToken": "jwt",
  "fieldId": "uuid",
  "fieldName": "Sales",
  "speakerRoster": [
    {
      "speakerId": "uuid",
      "displayName": "Alex",
      "role": "owner"
    }
  ],
  "expectedSpeakerCount": 4,
  "audioSource": "mixed_mic_tab"
}
```

Server emits:

```json
{
  "conversationId": "uuid",
  "isGuest": false,
  "mode": "multiple_speaker",
  "isDualSpeaker": false,
  "isMultiSpeaker": true,
  "rosterSpeakers": [
    {
      "speakerId": "uuid",
      "displayName": "Alex",
      "role": "owner"
    }
  ]
}
```

### Live multi-speaker transcript update

Server emits:

```json
{
  "mode": "multiple_speaker",
  "isFinal": true,
  "confidence": 0.92,
  "transcript": "We should start with timeline I agree",
  "segments": [
    {
      "deepgramSpeakerId": 0,
      "speakerId": null,
      "speakerLabel": "Guest 1",
      "text": "We should start with timeline",
      "startMs": 1000,
      "endMs": 3000,
      "confidence": 0.92,
      "identificationMethod": "diarization"
    },
    {
      "deepgramSpeakerId": 1,
      "speakerId": null,
      "speakerLabel": "Guest 2",
      "text": "I agree",
      "startMs": 3200,
      "endMs": 3900,
      "confidence": 0.9,
      "identificationMethod": "diarization"
    }
  ]
}
```

### Confirmed multi-speaker transcript

Server emits:

```json
{
  "mode": "multiple_speaker",
  "inputType": "voice",
  "transcript": "We should start with timeline I agree",
  "segments": []
}
```

### Speaker identified

Server emits:

```json
{
  "deepgramSpeakerId": 1,
  "speakerId": "local-speaker-uuid-or-null",
  "previousLabel": "Guest 2",
  "speakerLabel": "Sarah",
  "method": "voice_id",
  "similarityScore": 0.87,
  "audioSource": "per_speaker",
  "persisted": true
}
```

### Correct speaker

Client emits:

```json
{
  "deepgramSpeakerId": 1,
  "segmentId": "optional-segment-uuid",
  "speakerId": "local-speaker-uuid",
  "applyTo": "session_speaker"
}
```

Server success:

```json
{
  "deepgramSpeakerId": 1,
  "segmentId": "optional-segment-uuid",
  "speakerId": "local-speaker-uuid",
  "speakerLabel": "Sarah",
  "applyTo": "session_speaker",
  "persisted": true
}
```

### Rename guest

Client emits:

```json
{
  "deepgramSpeakerId": 2,
  "displayName": "Guest from Acme",
  "applyTo": "session_speaker"
}
```

Server success:

```json
{
  "deepgramSpeakerId": 2,
  "speakerId": null,
  "speakerLabel": "Guest from Acme",
  "method": "manual",
  "persisted": true
}
```

## Database Plan

Existing table:

- `conversation_transcript_segments`

Recommended follow-up migration:

```ts
import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("conversation_transcript_segments", (table) => {
    table.uuid("recording_session_id").nullable();
    table.index(
      ["conversation_id", "recording_session_id", "deepgram_speaker_id"],
      "idx_segments_recording_speaker",
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("conversation_transcript_segments", (table) => {
    table.dropIndex(
      ["conversation_id", "recording_session_id", "deepgram_speaker_id"],
      "idx_segments_recording_speaker",
    );
    table.dropColumn("recording_session_id");
  });
}
```

Optional but recommended:

- Add `updated_at` to `conversation_transcript_segments`.
- Add `source` or `input_type` if future imports/manual transcripts are expected.
- Add a check constraint for `identification_method` values once the enum stabilizes.

## Test Plan

The repo currently has no visible test/spec files and `npm run build` could not run locally because `node_modules/.bin/nest` is missing. Add tests before accepting the implementation.

### Unit tests

Target:

- `voice.gateway.ts` helper methods
- `conversation.service.ts` segment persistence methods

Cases:

1. `getAnonymousSpeakerLabel` returns stable labels:
   - speaker 0 -> `Guest 1`
   - speaker 4 -> `Guest 2`
   - speaker 0 again -> `Guest 1`

2. `buildMultiSpeakerTurns` groups words by speaker:
   - speaker 0 words become one turn
   - speaker 1 words become another turn
   - labels are resolved from `resolvedSpeakers` when present

3. `buildMultiSpeakerTurns` fallback works:
   - no words
   - final transcript exists
   - returns one fallback turn

4. Pending turns are not dropped:
   - 3-word turn remains pending
   - later 6-word turn triggers flush

5. Account-wide voice match maps external voice ID to local speaker ID.

6. Correction DB failure does not emit success.

### Integration tests

Target:

- Socket events around `session:start`, `transcript:update`, `utteranceEnd`, `audio:stop`
- Conversation read APIs

Cases:

1. Start `multiple_speaker` session and receive `session:ready`.
2. Emit simulated Deepgram final result with two speakers.
3. Confirm `transcript:update` includes `segments`.
4. Trigger utterance end and confirm:
   - `transcript:confirmed.mode === "multiple_speaker"`
   - `segments.length > 0`
   - segment rows are inserted
   - parent user message is inserted
   - assistant message is inserted
5. Call `GET /conversations/:id`.
6. Confirm response includes messages and `transcriptSegments`.
7. Correct a speaker and confirm DB row changes.
8. Force correction DB failure and confirm error event, no success event.

### Build verification

Run after dependencies are installed:

```bash
npm ci
npm run build
```

If tests are added:

```bash
npm test
```

If no test script exists, add one to `package.json` as part of the test setup.

## Rollout Order

Recommended implementation order:

1. Backend P1 correctness:
   - Fix pending turn clearing.
   - Fix `audio:stop` multi-speaker flush.
   - Fix speaker ID mapping.
   - Stop emitting correction success on DB failure.

2. Backend persistence/read model:
   - Add parent user message for multi-speaker exchanges.
   - Add `message_id` on segments.
   - Add `getTranscriptSegments`.
   - Add segments to `getConversation`.

3. Backend retroactive updates:
   - Update saved segments after voice ID.
   - Add `recording_session_id` if correction scopes must be accurate across multiple recordings in one conversation.

4. Backend tests:
   - Unit tests for helpers.
   - Service tests for segment persistence and correction.
   - Socket integration test for the happy path.

5. Web frontend parity:
   - Send `multiple_speaker`.
   - Render live and confirmed segments.
   - Handle speaker identification and correction events.
   - Load historical `transcriptSegments`.

6. Mobile frontend parity:
   - Confirm mode mapping sends `multiple_speaker`, not `multiple`, unless backend intentionally supports aliasing.
   - Render segments.
   - Add correction/rename controls.
   - Send audio chunk sequence and handle `audio:ack`.

7. QA and release:
   - Manual test with 3 speakers, no registered voices.
   - Manual test with 2 registered speakers and 1 unregistered guest.
   - Manual test stop button before utterance debounce.
   - Manual test refresh/reopen historical conversation.
   - Manual test failed correction persistence.

## Product Requirements For Frontend Parity

User task:

- The user records a conversation with more than two people and needs to understand who said what, even when the system does not know the names yet.

Required states:

- Idle
- Recording
- Live transcript with multiple speakers
- AI thinking
- AI response streaming
- Speaker identified
- Guest renamed
- Correction failed
- Conversation reload with historical speaker segments
- Network degraded/audio gap
- No voice identification configured

Required controls:

- Select recording mode: single, two speakers, multiple speakers.
- Optional roster selection for known speakers.
- Rename unknown guest.
- Correct speaker label from known speaker list.
- Apply correction to segment, session speaker, or conversation speaker.
- Retry failed correction.

Accessibility requirements:

- Speaker correction controls must be real buttons/selects.
- Icon-only controls need accessible names.
- Dynamic transcript updates should not steal focus.
- Error toasts should be readable and recoverable.
- Long speaker names and long utterances must wrap cleanly.

## Open Questions

1. Should `mode: "multiple"` remain supported as an alias, or should frontend always send `mode: "multiple_speaker"`?
2. Should guest users be allowed to use multi-speaker mode, or should it be authenticated-only because persistence and correction rely on user-owned speakers?
3. Should `speakerRoster` be optional, or should the UI encourage roster selection before recording?
4. Should manual guest renames create saved speaker profiles, or remain conversation-local labels?
5. Should voice identification run synchronously during recording, or should it be moved to a background job for reliability and lower latency?

## Final Backend Acceptance Checklist

- [ ] `multiple_speaker` session starts successfully.
- [ ] Deepgram diarization is enabled.
- [ ] Unknown speakers get stable `Guest N` labels.
- [ ] Short pending turns are not dropped.
- [ ] `audio:stop` flushes multi-speaker segments.
- [ ] `session:end` does not silently discard pending segments.
- [ ] Parent user message is saved for multi-speaker exchange.
- [ ] Segment rows include `message_id`.
- [ ] `speaker_id` stores local `speakers.id`, not external voice IDs.
- [ ] Saved segments are returned by conversation APIs.
- [ ] Voice ID updates existing saved segment labels.
- [ ] Manual correction persists before success event is emitted.
- [ ] Guest rename persists before success event is emitted.
- [ ] Tests cover helper logic, service persistence, correction failure, and socket happy path.
- [ ] `npm run build` passes.

## Final Frontend Acceptance Checklist

- [ ] Web sends `mode: "multiple_speaker"` for multi-speaker recording.
- [ ] Mobile sends the same backend mode value or backend supports its alias.
- [ ] Live transcript renders `segments`.
- [ ] Confirmed transcript stores grouped multi-speaker messages.
- [ ] Historical conversation reload renders `transcriptSegments`.
- [ ] `speaker:identified` updates the right Deepgram speaker only.
- [ ] `transcript:speaker_corrected` updates existing visible segments.
- [ ] Correction failure is visible and recoverable.
- [ ] Audio chunks include `sequence`.
- [ ] `audio:ack` and `session:degraded` are handled.
