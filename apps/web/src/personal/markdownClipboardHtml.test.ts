import { describe, expect, it } from "vite-plus/test";

import { markdownToClipboardHtml } from "./markdownClipboardHtml";

describe("markdownToClipboardHtml", () => {
  it("keeps structure for rich paste", () => {
    const html = markdownToClipboardHtml(
      [
        "# Title",
        "",
        "- one",
        "- two",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "See [docs](https://example.com/docs).",
      ].join("\n"),
    );

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('<code class="language-ts">const x = 1;\n</code>');
    expect(html).toContain('<a href="https://example.com/docs">docs</a>');
  });

  it("strips scripts and unsafe links", () => {
    const html = markdownToClipboardHtml(
      "<script>alert(1)</script>\n\n[bad](javascript:alert(1)) <img src=x onerror=alert(1)>",
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
    expect(html).toContain("bad");
  });
});
