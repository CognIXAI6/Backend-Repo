import { SummaryReport, TranscriptItem } from './summary-report.types';

const turn = (speaker: string, text: string): TranscriptItem => ({ kind: 'turn', speaker, text });
const insights = (...bullets: string[]): TranscriptItem => ({ kind: 'insights', bullets });

/** A realistic three-session report (synthetic content) used by renderer tests and the visual sample. */
export function sampleReport(): SummaryReport {
  return {
    title: 'Grounding System Oxidation and Corrosion Control',
    generatedAt: '2026-11-17T09:30:00.000Z',
    sessions: [
      {
        number: 1,
        date: '2026-11-13T09:00:00.000Z',
        title: 'Construction Site Daily Coordination Meeting Recap',
        description: 'A multi-site construction coordination meeting covering substation oil filling, grounding rod installation progress, equipment issues, and quality oversight.',
        summary:
          'The meeting opened with brief safety observations, including hazard identification at the bottom of a hill near a stop sign and a reminder that proactive hazard spotting prevents future issues. Speaker 2 then gave a broad daily activity rundown covering multiple sites, including substation work (backfill, conduit, oil filling on T2), transmission line work, vault and sidewalk work, and an expected crew of 32 the following day. The grounding rod installation was identified as a key concern: one drill rig had been removed from site the previous day due to a hydraulic leak and safety concerns, leaving only one rig operating at approximately 6 rods per day — well below the rate needed to complete 340 total rods.',
        transcript: [
          turn('Speaker 1', 'especially the bottom of the hill for the stop sign next positive oxidation'),
          insights(
            'Mention of “positive oxidation” may relate to grounding system corrosion risk — worth flagging.',
            'Bentonite backfill helps mitigate oxidation; confirm it’s being applied correctly at all rod locations.',
            '“Bottom of the hill” location may have drainage/moisture issues affecting ground rod integrity — investigate.',
          ),
          turn('Speaker 1', 'followed and co working with eli certainly my cheryl housekeeping is done in delineations are set up through take your time and actually observe what’s happening the hazards you touched today prevent some of the issues tomorrow thank you'),
          turn('Speaker 2', 'alright thank you it’s all happening'),
          insights(
            'Sounds like a safety walkdown or hazard ID session just wrapped up — good timing.',
            'Reinforce this habit; proactive hazard observation ties directly to NCR prevention.',
          ),
          turn('Speaker 4', 'we are continuing to update the jabouk and quality warrants in build and then we’ll have our poaqc meeting at 10:30 with morales thank you'),
          turn('Speaker 2', 'first of all i’m saying today burtonville 58405 berkeley 3 avenue avalon 7 walter 31hp power 1a6n6 spartan 5 land shark 2 apache 3 and the cleaners two activities today the fast are tearing cables i was doing the esc acoustic installs bonded installation backfill and grate and transfer for conduit in the substation john correct me if i’m wrong turnings yesterday yes i thought alright the turning table 34.5 steel oil filling important heat and ground installation on the t line we’ve got pipe fiber pole conduit installation backfill integrating and vault work and then sidewalk work'),
          insights(
            'Oil filling mentioned — confirm hold/witness point sign-off is complete before proceeding.',
            'Ground installation activity noted — verify those rods reach 6m depth with bentonite backfill.',
            '32 crew members expected tomorrow — good opportunity to push NCR closeout capacity.',
          ),
          turn('Speaker 3', 'okay did apologize did they get a a different rate yesterday'),
          turn('Speaker 8', 'no they threw a different site for repair it was a leak so i think that it was a third party mechanical service we requested we remove it just because of what happened with the finger and the excavator'),
          insights('Current rate (~6/day) is insufficient; confirm second rig arrival date is locked in.', 'Push for a committed end date from the contractor before Monday.'),
        ],
        keyInsights: [
          'Proactive hazard identification during the walkdown was explicitly linked to preventing future NCRs — a cultural win worth reinforcing.',
          'The drill rig removal was a deliberate safety decision (leak + prior injury precedent), not a mechanical failure alone — this distinction matters for documentation.',
          'At ~6 rods/day with one rig, the current pace is materially insufficient for completing 340 ground rods; the second rig arriving Monday is critical to close the gap.',
          'Difficulty achieving safe sloping near substation foundations may have compromised rod depth or angle — a potential NCR if rods did not meet the 6m + bentonite specification.',
        ],
        actionPoints: [
          'Confirm hold/witness point sign-off is completed before T2 oil filling begins, and monitor temperature bring-up given cold conditions.',
          'Log RFI R5423 response regarding merging units and confirm revised delivery date (Monday) is on track.',
          'Lock in the exact arrival date for the second drill rig and obtain a committed daily rod installation target from the contractor.',
          'Update David’s live tracker to reflect yesterday’s downtime, the revised daily rate, and any rods that may not have reached depth.',
          'Document the drill rig removal as a formal safety decision, including the reason (leak + prior injury risk).',
        ],
      },
      {
        number: 2,
        date: '2026-11-16T09:00:00.000Z',
        title: 'Construction Site Quality & Grounding Progress Meeting',
        description: 'Weekly construction site meeting covering quality documentation updates, grounding rod installation challenges, fiber pull progress, and merchant unit status.',
        summary: 'The meeting opened with quality team members discussing updates to the quality job book, conversion of quality forms from Excel to PDF, and the workflow for sending those PDFs to a review group for acceptance. The team then moved into field progress updates, with grounding rod installation being significantly slowed by subsurface rock, a second drill rig still not on-site, and fiber pull from the weekend left incomplete.',
        transcript: [
          turn('Speaker 1', 'we have quality update we are continuing to update the well our quality job book and then doing quality forms in the bin build then who’s that exporting those excel files'),
          insights('Quality job book updates are ongoing — confirm forms are version-controlled and traceable.', 'Identify and assign a single owner for exporting/distributing the Excel files to avoid gaps.'),
          turn('Speaker 2', 'perfect so it will be it will be official and then we’ll have a good'),
        ],
        keyInsights: ['Grounding rod installation is the critical path for backfill; a firm end date is needed now.'],
        actionPoints: ['Assign a named owner for the PDF export and distribution step of the quality form workflow.', 'Get a firm arrival date for the second drill rig today.'],
      },
      {
        number: 3,
        date: '2026-11-17T08:30:00.000Z',
        title: 'November 17 Site Morning Meeting Recap',
        description: 'Daily construction site meeting covering safety, grounding delays, merging unit risk, transformer oil circulation, fiber/splicing status, and hold/witness point tracking.',
        summary: 'The November 17 morning site meeting opened with a safety review covering lift operations and basket work approvals. The hot topic was grounding production, which was described as critically behind schedule with diamond bits failing and vendors being contacted for alternate solutions.',
        transcript: [
          turn('Speaker 1', 'alright good morning everybody november 17 let’s start with safety i’m here for approval we’re working in a bad lift stable in the contact with basket and so'),
          insights('Confirm the lift plan is formally approved before any basket work begins.', 'Ensure a completed JSA/hazard assessment is on-site and signed off.'),
        ],
        keyInsights: [],
        actionPoints: ['Ensure the distribution list includes relevant parties for the merchant unit delivery email.'],
      },
    ],
  };
}
