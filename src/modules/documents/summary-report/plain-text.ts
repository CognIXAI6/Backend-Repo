/**
 * Model replies arrive as markdown ("**bold**", "`code`", "# heading", "[link](url)"). The report is plain
 * typography, so the markers are removed and only the words are kept. Applied at render time, so sessions
 * saved earlier are cleaned too.
 */
export function cleanMarkdown(input: string): string {
  return String(input ?? '')
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1')
    .replace(/!?\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')
    .replace(/\*\*\*(.+?)\*\*\*/gs, '$1')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/(?<![\w_])__(.+?)__(?![\w_])/gs, '$1')
    .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\w_])/g, '$1')
    .replace(/~~(.+?)~~/gs, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\*\*|__/g, '');
}
