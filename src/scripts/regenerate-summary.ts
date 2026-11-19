/**
 * Re-run the meeting summary for one conversation, outside a live session.
 *
 *   node dist/scripts/regenerate-summary.js --conversation <conversation-id> [--dry-run]
 *   node dist/scripts/regenerate-summary.js --conversation <conversation-id> --rebuild [--email]
 *
 * Uses the exact path a real session end uses, so the owner gets the same result:
 *   • the summary document (all sessions of the conversation, new format)
 *   • an assistant message in the chat that links the document
 *   • a push notification and the summary email with the PDF attached
 *
 * Safe to re-run: only messages not yet covered by a saved summary part are summarised,
 * a summary that is already up to date is left alone, and a run already in progress
 * (e.g. the live gateway finishing the same conversation) is not duplicated.
 * The run counts as one document against the owner's monthly plan allowance.
 *
 * --dry-run prints the owner, plan, current status and how many messages would be
 * summarised, and changes nothing.
 *
 * --rebuild re-renders the EXISTING summary (all saved sessions) with every transcript rebuilt
 * from the stored messages and speaker segments — e.g. after a speaker-attribution fix. No AI
 * calls, nothing re-summarised, no document quota used. The corrected document is posted into
 * the chat; add --email to also email it to the owner.
 */
import { NestFactory } from '@nestjs/core';
import { Knex } from 'knex';
import { GatewayAppModule } from '../app-gateway.module';
import { KNEX_CONNECTION } from '../database/database.module';
import { VoiceGateway } from '../modules/voice/voice.gateway';
import { ConversationService } from '../modules/voice/services/conversation.service';
import { EntitlementsService } from '../modules/entitlements/entitlements.service';

const EMAIL_WAIT_MS = 90_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const conversationId = arg('conversation');
  const dryRun = process.argv.includes('--dry-run');
  const rebuild = process.argv.includes('--rebuild');
  const email = process.argv.includes('--email');
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) {
    console.error('Usage: node dist/scripts/regenerate-summary.js --conversation <conversation-id> [--dry-run | --rebuild [--email]]');
    return 2;
  }

  const app = await NestFactory.createApplicationContext(GatewayAppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const knex = app.get<Knex>(KNEX_CONNECTION);
    const conv = await knex('conversations')
      .where({ id: conversationId })
      .whereNull('deleted_at')
      .first('id', 'user_id', 'title', 'summary_status', 'summary_skip_reason');
    if (!conv) {
      console.error(`Conversation ${conversationId} not found (or deleted).`);
      return 1;
    }
    const owner = await knex('users').where({ id: conv.user_id }).first('email');
    const { tier, entitlements } = await app.get(EntitlementsService).getUserEntitlements(conv.user_id);
    const pending = await app.get(ConversationService).getUnsummarizedMessages(conversationId, conv.user_id);

    console.log(`Conversation : ${conv.title ?? '(untitled)'} (${conversationId})`);
    console.log(`Owner        : ${owner?.email ?? conv.user_id}`);
    console.log(`Plan         : ${tier} — ${entitlements.maxDocumentsPerMonth} documents/month, depths [${entitlements.allowedDocumentDepths.join(', ')}]`);
    console.log(`Status now   : ${conv.summary_status}${conv.summary_skip_reason ? ` / ${conv.summary_skip_reason}` : ''}`);
    console.log(`To summarise : ${pending.length} message(s) not yet covered by a summary`);

    const parts = await app.get(ConversationService).getSummaryParts(conversationId, conv.user_id);
    const source = await app.get(ConversationService).getMessagesWithSegments(conversationId, conv.user_id);
    const segSpeakers = [...new Set(source.flatMap((m) => m.segments.map((x) => x.speaker_label)))];
    console.log(`Saved parts  : ${parts.length} session(s) already summarised`);
    console.log(`Speakers     : ${segSpeakers.length ? segSpeakers.join(', ') : '(no speaker segments — single-speaker or older messages)'}`);

    if (dryRun) {
      console.log('\nDry run — nothing changed.');
      return 0;
    }

    if (rebuild) {
      console.log(`\nRebuilding the existing summary document${email ? ' (and emailing it)' : ''}…`);
      const r = await app.get(VoiceGateway).rebuildSummaryDocument(conversationId, conv.user_id, { email });
      console.log(`Document     : ${r.title} — ${r.sessions} session(s)`);
      console.log(`Speakers     : ${r.speakers.join(', ') || '(none)'}`);
      console.log(`Download URL : ${r.downloadUrl}`);
      console.log('Chat message : added — the owner sees the corrected document when they open the conversation');
      if (email) {
        const row = await knex('conversations').where({ id: conversationId }).first('summary_email_status', 'summary_email_reason');
        console.log(`Email        : ${row?.summary_email_status ?? 'unknown'}${row?.summary_email_reason ? ` / ${row.summary_email_reason}` : ''}`);
      }
      return 0;
    }

    console.log('\nGenerating…');
    const startedAt = new Date();
    const result = await app.get(VoiceGateway).regenerateSummaryForConversation(conversationId, conv.user_id);
    console.log(`Status       : ${result.summaryStatus}${result.skipReason ? ` / ${result.skipReason}` : ''}`);

    if (result.summaryStatus !== 'ready' || !result.events.includes('document:ready')) {
      console.log(
        result.summaryStatus === 'ready'
          ? 'Nothing new to summarise — the existing summary already covers this conversation. No email sent.'
          : 'No document was produced. Check the gateway log lines above for the reason.',
      );
      return result.summaryStatus === 'ready' ? 0 : 1;
    }

    const doc = await knex('generated_documents').where({ id: result.documentId }).first('title', 'download_url');
    console.log(`Document     : ${doc?.title ?? result.documentId}`);
    console.log(`Download URL : ${doc?.download_url ?? '(none)'}`);
    console.log('Chat message : added — the owner sees the document when they open the conversation');

    // The email is sent fire-and-forget by the summary path; wait for its outcome
    // before shutting down so the process doesn't exit mid-send.
    process.stdout.write('Email        : ');
    const deadline = Date.now() + EMAIL_WAIT_MS;
    for (;;) {
      const row = await knex('conversations').where({ id: conversationId }).first('summary_email_status', 'summary_email_reason', 'summary_email_updated_at');
      const fresh = row?.summary_email_updated_at && new Date(row.summary_email_updated_at) >= startedAt;
      if (fresh && row.summary_email_status !== 'pending') {
        console.log(`${row.summary_email_status}${row.summary_email_reason ? ` / ${row.summary_email_reason}` : ''}`);
        break;
      }
      if (Date.now() > deadline) {
        console.log('still pending after 90s — check the gateway log for "Summary-ready email"');
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Failed:', err?.message ?? err);
    process.exit(1);
  });
