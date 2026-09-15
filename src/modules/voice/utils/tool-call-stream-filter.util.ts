const OPEN_TAGS = ['<tool_call>', '<tool_response>'];
const CLOSE_TAGS = ['</tool_call>', '</tool_response>'];
const LONGEST_TAG_LEN = Math.max(...OPEN_TAGS.map((t) => t.length));

/**
 * Scrubs a hallucinated `<tool_call>...</tool_call>` (or `<tool_response>`)
 * narration out of a live token stream before it reaches the client.
 *
 * `stripToolCallArtifacts` in ClaudeService only cleans the aggregated final
 * text passed to `onDone` — by then the raw tokens have already been emitted
 * one at a time via `onToken`. This filter sits in front of that live emit:
 * it holds back a small tail buffer (long enough to contain a partial tag)
 * so a tag split across multiple stream chunks is still caught, and drops
 * everything between a matched open/close tag pair instead of forwarding it.
 */
export class ToolCallStreamFilter {
  private buffer = '';
  private suppressing = false;

  /** Feed the next streamed token; returns the text (if any) safe to emit now. */
  push(token: string): string {
    this.buffer += token;
    let output = '';

    for (;;) {
      if (this.suppressing) {
        const closeIdx = this.earliestIndex(CLOSE_TAGS);
        if (closeIdx === -1) return output;

        const tag = CLOSE_TAGS.find((t) => this.buffer.startsWith(t, closeIdx))!;
        this.buffer = this.buffer.slice(closeIdx + tag.length);
        this.suppressing = false;
        continue;
      }

      const openIdx = this.earliestIndex(OPEN_TAGS);
      if (openIdx !== -1) {
        output += this.buffer.slice(0, openIdx);
        const tag = OPEN_TAGS.find((t) => this.buffer.startsWith(t, openIdx))!;
        this.buffer = this.buffer.slice(openIdx + tag.length);
        this.suppressing = true;
        continue;
      }

      const holdBack = this.partialOpenTagSuffixLength();
      output += this.buffer.slice(0, this.buffer.length - holdBack);
      this.buffer = this.buffer.slice(this.buffer.length - holdBack);
      return output;
    }
  }

  private earliestIndex(tags: string[]): number {
    let best = -1;
    for (const tag of tags) {
      const idx = this.buffer.indexOf(tag);
      if (idx !== -1 && (best === -1 || idx < best)) best = idx;
    }
    return best;
  }

  /** Length of the buffer's tail that could still grow into an opening tag. */
  private partialOpenTagSuffixLength(): number {
    const maxLen = Math.min(LONGEST_TAG_LEN - 1, this.buffer.length);
    for (let len = maxLen; len > 0; len--) {
      const suffix = this.buffer.slice(this.buffer.length - len);
      if (OPEN_TAGS.some((tag) => tag.startsWith(suffix))) return len;
    }
    return 0;
  }
}
