export interface SummarySection {
  heading: string;
  content: string;
}

export interface SummaryPart {
  title: string;
  topic: string | null;
  sections: SummarySection[];
  covers_from: Date;
}

export function formatSessionDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Stitches every summarised stretch of a conversation into one document.
 * A conversation with a single part keeps the original flat layout; once it
 * has been resumed, each part gets a "Session N · date — title" header (with
 * its topic) ahead of its own sections, oldest first.
 */
export function buildCombinedSummary(
  parts: SummaryPart[],
  conversationTitle: string | null,
): { title: string; topic: string; sections: SummarySection[] } {
  if (parts.length === 1) {
    return { title: parts[0].title, topic: parts[0].topic ?? '', sections: parts[0].sections };
  }

  const sections: SummarySection[] = [];
  parts.forEach((part, i) => {
    sections.push({
      heading: `Session ${i + 1} · ${formatSessionDate(part.covers_from)} — ${part.title}`,
      content: part.topic?.trim() || part.title,
    });
    sections.push(...part.sections);
  });

  const base = conversationTitle?.trim() || parts[0].title;
  return {
    title: `${base} — ${parts.length} sessions`,
    topic: parts[0].topic ?? '',
    sections,
  };
}
