// Fork-local (iTerm2 mode): render one assistant turn's text to safe HTML for the
// reading view (TranscriptOverlay). Same marked + DOMPurify pair the wiki renderer
// uses, minus the wiki-specific steps: no [[link]] pass (agent replies use plain
// markdown), no frontmatter strip, no image-src rewrite (a reply's image refs are
// arbitrary local paths the raw route may not serve; DOMPurify keeps the tag and a
// broken image is honest). Sanitizing matters here for the same reason as the wiki:
// the text is LLM-authored and lands in the app origin via v-html.
import { marked } from "marked";
import DOMPurify from "dompurify";

export function renderTurnHtml(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
