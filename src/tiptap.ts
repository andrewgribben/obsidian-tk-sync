// Tiptap/ProseMirror JSON -> Markdown. Pure module: no 'obsidian' import.
//
// Deliberate shortcut: we never escape Markdown special characters in plain
// text (no backslash-escaping of '*', '_', '[', '#', etc). TK round-trips
// '[[wikilinks]]' and '#tags' as literal text in the vault, and escaping
// them would break that round trip. This means text that coincidentally
// looks like Markdown syntax (e.g. a literal "**" in prose) will render as
// if it were formatting when the Markdown is viewed elsewhere. Accepted.

import type { TiptapNode, TkDoc } from "./types.ts";

const BULLET_INDENT = 2;
const ORDERED_INDENT = 3;

/** Marks we never render (AI attribution, not a formatting concern). */
function visibleMarks(node: TiptapNode): { type: string; attrs?: Record<string, unknown> }[] {
  return (node.marks ?? []).filter((m) => m.type !== "author");
}

function markKey(marks: { type: string; attrs?: Record<string, unknown> }[]): string {
  const normalised = marks
    .map((m) => ({ type: m.type, attrs: m.attrs ?? null }))
    .sort((a, b) => a.type.localeCompare(b.type));
  return JSON.stringify(normalised);
}

/** Merge adjacent text nodes that carry identical (visible) marks. */
function mergeAdjacentText(nodes: TiptapNode[]): TiptapNode[] {
  const merged: TiptapNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const marks = visibleMarks(node);
      const key = markKey(marks);
      const prev = merged[merged.length - 1];
      if (prev && prev.type === "text" && markKey(visibleMarks(prev)) === key) {
        prev.text = (prev.text ?? "") + (node.text ?? "");
        continue;
      }
      merged.push({ type: "text", text: node.text ?? "", marks });
      continue;
    }
    merged.push(node);
  }
  return merged;
}

function wrapWithMarks(text: string, marks: { type: string; attrs?: Record<string, unknown> }[]): string {
  let out = text;
  const has = (t: string) => marks.some((m) => m.type === t);
  if (has("code")) out = "`" + out + "`";
  if (has("strike")) out = "~~" + out + "~~";
  if (has("italic")) out = "_" + out + "_";
  if (has("bold")) out = "**" + out + "**";
  const link = marks.find((m) => m.type === "link");
  if (link) {
    const href = typeof link.attrs?.href === "string" ? link.attrs.href : "";
    out = "[" + out + "](" + href + ")";
  }
  return out;
}

/** Collect data-id -> referenceNumber from every footnoteReference in the tree. */
function collectFootnoteRefs(nodes: TiptapNode[], map: Map<string, string>): void {
  for (const node of nodes) {
    if (node.type === "footnoteReference") {
      const dataId = node.attrs?.["data-id"];
      const refNum = node.attrs?.["referenceNumber"];
      if (typeof dataId === "string" && refNum !== undefined) {
        map.set(dataId, String(refNum));
      }
    }
    if (node.content) collectFootnoteRefs(node.content, map);
  }
}

/** Render a run of inline content (text, image, hardBreak, footnoteReference, ...). */
function renderInline(nodes: TiptapNode[], refs: Map<string, string>): string {
  const merged = mergeAdjacentText(nodes);
  let out = "";
  for (const node of merged) {
    switch (node.type) {
      case "text":
        out += wrapWithMarks(node.text ?? "", visibleMarks(node));
        break;
      case "hardBreak":
        out += "  \n";
        break;
      case "image": {
        const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
        const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
        out += "![" + alt + "](" + src + ")";
        break;
      }
      case "footnoteReference": {
        const dataId = node.attrs?.["data-id"];
        const refNum =
          typeof dataId === "string" && refs.has(dataId)
            ? refs.get(dataId)
            : node.attrs?.["referenceNumber"] !== undefined
              ? String(node.attrs["referenceNumber"])
              : "";
        out += "[^" + refNum + "]";
        break;
      }
      case "mention": {
        // Mentions carry only an id; a library mention becomes a link so it survives as something usable.
        const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
        out += node.attrs?.mentionType === "library" ? `[TK library](https://tk.xyz/libraries/${id})` : `@${id}`;
        break;
      }
      default:
        // Unknown inline node: fall back to its children or raw text so
        // content is never silently dropped.
        if (node.content) out += renderInline(node.content, refs);
        else if (typeof node.text === "string") out += node.text;
        break;
    }
  }
  return out;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Render the single block that forms the "head" of a list item's own line. */
function renderListItemHead(block: TiptapNode, refs: Map<string, string>): string {
  if (block.content) return renderInline(block.content, refs);
  if (typeof block.text === "string") return block.text;
  return "";
}

function renderListItem(item: TiptapNode, marker: string, refs: Map<string, string>): string {
  const blocks = item.content ?? [];
  if (blocks.length === 0) return marker;
  const [head, ...rest] = blocks;
  const headText = renderListItemHead(head, refs);
  const lines: string[] = [marker + headText];
  for (const block of rest) {
    const rendered = renderBlock(block, refs);
    const indent = block.type === "orderedList" ? ORDERED_INDENT : BULLET_INDENT;
    const pad = " ".repeat(indent);
    for (const line of rendered.split("\n")) lines.push(pad + line);
  }
  return lines.join("\n");
}

function renderBulletLikeList(list: TiptapNode, refs: Map<string, string>): string {
  const items = (list.content ?? []).map((item) => {
    if (item.type === "taskItem") {
      const marker = item.attrs?.checked ? "- [x] " : "- [ ] ";
      return renderListItem(item, marker, refs);
    }
    return renderListItem(item, "- ", refs);
  });
  return items.join("\n");
}

function renderOrderedList(list: TiptapNode, refs: Map<string, string>): string {
  const start = typeof list.attrs?.start === "number" ? list.attrs.start : 1;
  const items = (list.content ?? []).map((item, i) => renderListItem(item, `${start + i}. `, refs));
  return items.join("\n");
}

function renderTableCell(cell: TiptapNode, refs: Map<string, string>): string {
  const text = (cell.content ?? [])
    .map((block) => (block.content ? renderInline(block.content, refs) : ""))
    .join(" ");
  return escapeTableCell(text);
}

function renderTable(table: TiptapNode, refs: Map<string, string>): string {
  const rows = table.content ?? [];
  if (rows.length === 0) return "";
  const rendered = rows.map((row) => (row.content ?? []).map((cell) => renderTableCell(cell, refs)));
  const colCount = rendered[0]?.length ?? 0;
  const lines: string[] = [];
  lines.push("| " + rendered[0].join(" | ") + " |");
  lines.push("| " + Array.from({ length: colCount }, () => "---").join(" | ") + " |");
  for (const row of rendered.slice(1)) {
    lines.push("| " + row.join(" | ") + " |");
  }
  return lines.join("\n");
}

function renderBlockquote(bq: TiptapNode, refs: Map<string, string>): string {
  const inner = renderBlocks(bq.content ?? [], refs);
  return inner
    .split("\n")
    .map((line) => (line.length ? "> " + line : ">"))
    .join("\n");
}

function renderCodeBlock(block: TiptapNode): string {
  const lang = typeof block.attrs?.language === "string" ? block.attrs.language : "";
  const raw = (block.content ?? []).map((n) => n.text ?? "").join("");
  const text = raw.replace(/\n$/, "");
  return "```" + lang + "\n" + text + "\n```";
}

function renderFootnotes(block: TiptapNode, refs: Map<string, string>): string {
  const defs = (block.content ?? [])
    .filter((n) => n.type === "footnote")
    .map((footnote) => {
      const dataId = footnote.attrs?.["data-id"];
      const num = typeof dataId === "string" && refs.has(dataId) ? refs.get(dataId) : "?";
      const text = renderBlocks(footnote.content ?? [], refs);
      return "[^" + num + "]: " + text;
    });
  return defs.join("\n");
}

/** Render a single block-level node to a (possibly multi-line) Markdown string. */
function renderBlock(node: TiptapNode, refs: Map<string, string>): string {
  switch (node.type) {
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      return "#".repeat(level) + " " + renderInline(node.content ?? [], refs);
    }
    case "paragraph":
      return renderInline(node.content ?? [], refs);
    case "bulletList":
    case "taskList":
      return renderBulletLikeList(node, refs);
    case "orderedList":
      return renderOrderedList(node, refs);
    case "blockquote":
    case "pullquote":
      return renderBlockquote(node, refs);
    case "figure": {
      // TK's image block; its inline content is the caption, kept as the next line.
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      const caption = renderInline(node.content ?? [], refs);
      return "![" + alt + "](" + src + ")" + (caption ? "\n" + caption : "");
    }
    case "embed":
      // Embeds (SoundCloud, YouTube...) carry only a URL; a bare URL line is the closest Markdown.
      return typeof node.attrs?.url === "string" ? node.attrs.url : "";
    case "codeBlock":
      return renderCodeBlock(node);
    case "horizontalRule":
      return "---";
    case "table":
      return renderTable(node, refs);
    case "image": {
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      return "![" + alt + "](" + src + ")";
    }
    case "footnotes":
      return renderFootnotes(node, refs);
    default:
      // Unknown block type: render children as blocks (or text) so content
      // is never lost.
      if (node.content) return renderBlocks(node.content, refs);
      if (typeof node.text === "string") return node.text;
      return "";
  }
}

/** Render a sequence of block-level nodes, separated by one blank line each. */
function renderBlocks(nodes: TiptapNode[], refs: Map<string, string>): string {
  const rendered = nodes
    .filter((n) => n.type !== "footnotes")
    .map((n) => renderBlock(n, refs));
  const footnoteBlocks = nodes.filter((n) => n.type === "footnotes").map((n) => renderBlock(n, refs));
  return [...rendered, ...footnoteBlocks].filter((s) => s.length > 0).join("\n\n");
}

/** Full Tiptap document (or any node with `content`) to Markdown. */
export function tiptapToMarkdown(root: TiptapNode): string {
  const content = root.content ?? [];
  const refs = new Map<string, string>();
  collectFootnoteRefs(content, refs);
  const body = renderBlocks(content, refs);
  return body.endsWith("\n") ? body : body + "\n";
}

/**
 * TK document to Markdown. Drops the leading heading level 1 when its text
 * exactly matches the document title (TK stores the title as the first H1
 * of the body as well as in doc.title).
 */
export function docToMarkdown(doc: TkDoc): string {
  const content = doc.content.content ?? [];
  const first = content[0];
  const isTitleHeading =
    first &&
    first.type === "heading" &&
    first.attrs?.level === 1 &&
    (first.content ?? [])
      .filter((n) => n.type === "text")
      .map((n) => n.text ?? "")
      .join("") === doc.title;
  const rest = isTitleHeading ? content.slice(1) : content;
  const refs = new Map<string, string>();
  collectFootnoteRefs(rest, refs);
  const body = renderBlocks(rest, refs);
  return body.endsWith("\n") ? body : body + "\n";
}
