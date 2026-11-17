import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tiptapToMarkdown, docToMarkdown } from "../src/tiptap.ts";
import type { TiptapNode, TkDoc } from "../src/types.ts";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

function readFixture(name: string): string {
  return readFileSync(fixtureDir + name, "utf8");
}

/**
 * Normalise a GFM pipe table's cosmetic spacing (we emit single spaces
 * around cells; the fixture is hand-padded for readability) so the
 * end-to-end comparison can still be an exact string match elsewhere.
 * Collapses runs of spaces inside '| ... |' table lines to one space.
 */
function normaliseTables(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => (line.startsWith("|") ? line.replace(/[ \t]+/g, " ").replace(/\|\s*-+\s*/g, "| --- ").trimEnd() : line))
    .join("\n");
}

test("docToMarkdown matches the hand-written sample fixture", () => {
  const root = JSON.parse(readFixture("sample.tiptap.json")) as TiptapNode;
  const tkDoc: TkDoc = {
    id: "fixture",
    title: "TK sync spike test (safe to delete)",
    tags: [],
    created_at: "",
    updated_at: "",
    content: root,
  };
  const expected = readFixture("sample.md");
  const actual = docToMarkdown(tkDoc);
  assert.equal(normaliseTables(actual), normaliseTables(expected));
});

test("tiptapToMarkdown accepts a root without a 'type' field", () => {
  const root = { content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] } as TiptapNode;
  assert.equal(tiptapToMarkdown(root), "hello\n");
});

test("nested bullet list indents by two spaces", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "one" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }],
                  },
                ],
              },
            ],
          },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
        ],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "- one\n  - nested\n- two\n");
});

test("nested ordered list indents by three spaces", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "one" }] },
              {
                type: "orderedList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "1. one\n   1. nested\n");
});

test("ordered list honours attrs.start", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "orderedList",
        attrs: { start: 5 },
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "five" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "six" }] }] },
        ],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "5. five\n6. six\n");
});

test("adjacent text nodes with identical marks merge", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bo", marks: [{ type: "bold" }] },
          { type: "text", text: "ld", marks: [{ type: "bold" }] },
        ],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "**bold**\n");
});

test("author marks are ignored and do not block merging", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "bo",
            marks: [{ type: "bold" }, { type: "author", attrs: { authorId: "x", authorType: "ai" } }],
          },
          { type: "text", text: "ld", marks: [{ type: "bold" }] },
        ],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "**bold**\n");
});

test("link wraps outermost, so bold text inside a link reads naturally", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "bold link",
            marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }],
          },
        ],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "[**bold link**](https://example.com)\n");
});

test("task items render as GFM checkboxes", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph", content: [{ type: "text", text: "open" }] }],
          },
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }],
          },
        ],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "- [ ] open\n- [x] done\n");
});

test("blockquote with multiple paragraphs prefixes every line, blank line included", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "blockquote",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "first" }] },
          { type: "paragraph", content: [{ type: "text", text: "second" }] },
        ],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "> first\n>\n> second\n");
});

test("unknown node types fall back to rendering their children", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [
      {
        type: "weirdFutureBlock",
        content: [{ type: "paragraph", content: [{ type: "text", text: "still here" }] }],
      },
    ],
  };
  assert.equal(tiptapToMarkdown(root), "still here\n");
});

test("docToMarkdown keeps the leading H1 when it does not match the title", () => {
  const doc: TkDoc = {
    id: "x",
    title: "Expected Title",
    tags: [],
    created_at: "",
    updated_at: "",
    content: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Different heading" }] },
        { type: "paragraph", content: [{ type: "text", text: "body" }] },
      ],
    },
  };
  assert.equal(docToMarkdown(doc), "# Different heading\n\nbody\n");
});

test("wikilinks and tags pass through unescaped (deliberate shortcut)", () => {
  const root: TiptapNode = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "[[Some Note]] and #inline-tag" }] }],
  };
  assert.equal(tiptapToMarkdown(root), "[[Some Note]] and #inline-tag\n");
});

test("TK-specific nodes seen in real notes: figure, pullquote, embed, mention, tkInlinePrompt", () => {
  const md = tiptapToMarkdown({
    type: "doc",
    content: [
      { type: "figure", attrs: { src: "https://x/a.png", alt: "Alt" }, content: [{ type: "text", text: "Caption" }] },
      { type: "figure", attrs: { src: "https://x/b.png", alt: "" } },
      { type: "pullquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Pulled." }] }] },
      { type: "embed", attrs: { url: "https://soundcloud.com/a/b" } },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See " },
          { type: "mention", attrs: { id: "lib-1", mentionType: "library" } },
          { type: "text", text: " and " },
          { type: "tkInlinePrompt", attrs: { status: "solved" }, content: [{ type: "text", text: "prompt text" }] },
        ],
      },
    ],
  });
  assert.equal(
    md,
    "![Alt](https://x/a.png)\nCaption\n\n![](https://x/b.png)\n\n> Pulled.\n\nhttps://soundcloud.com/a/b\n\n" +
      "See [TK library](https://tk.xyz/libraries/lib-1) and prompt text\n",
  );
});
