import { toHtml } from "hast-util-to-html";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

// Raw HTML in the source is dropped (remark-rehype default) and the default sanitize schema
// removes scripts, event handlers and non-web link protocols, so the clipboard HTML is safe to
// paste into any rich-text target. Custom chat protocols (file:, t3-citation:) lose their href.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize, defaultSchema);

/**
 * Renders assistant markdown to a sanitized HTML fragment for the `text/html` clipboard flavor,
 * so rich-text editors (Docs, Slack, Notion) keep headings, lists, tables, code blocks and links.
 */
export function markdownToClipboardHtml(markdown: string): string {
  const tree = processor.runSync(processor.parse(markdown));
  return `<meta charset="utf-8">${toHtml(tree)}`;
}
