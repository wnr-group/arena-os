import type { ReactNode } from 'react'

/**
 * "Light Markdown" (M13 v1 scope) — deliberately not a general-purpose
 * CommonMark engine. Supports paragraphs, bullet lists, **bold**, *italic*,
 * and [label](https://url) links (http/https only). Builds React elements
 * directly rather than parsing to an HTML string, so it is XSS-safe by
 * construction — there is no `dangerouslySetInnerHTML` anywhere in this
 * path and nothing to sanitise; a stray `<script>` in the source renders as
 * inert text, the same as any other character.
 */
const INLINE_PATTERN = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
const LIST_ITEM_PATTERN = /^[-*]\s+(.*)$/

function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let i = 0
  INLINE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_PATTERN.exec(line))) {
    if (match.index > lastIndex) nodes.push(line.slice(lastIndex, match.index))
    const key = `${keyPrefix}-${i++}`
    const [, bold, italic, linkLabel, linkUrl] = match
    if (bold !== undefined) {
      nodes.push(<strong key={key}>{bold}</strong>)
    } else if (italic !== undefined) {
      nodes.push(<em key={key}>{italic}</em>)
    } else if (linkLabel !== undefined && linkUrl !== undefined) {
      nodes.push(
        <a
          key={key}
          href={linkUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="underline underline-offset-2 hover:text-primary"
        >
          {linkLabel}
        </a>,
      )
    }
    lastIndex = INLINE_PATTERN.lastIndex
  }
  if (lastIndex < line.length) nodes.push(line.slice(lastIndex))
  return nodes
}

export function renderLightMarkdown(text: string): ReactNode[] {
  const blocks = text.trim().split(/\n\s*\n/).filter(Boolean)
  return blocks.map((block, bi) => {
    const lines = block.split('\n')
    const listItems = lines.map((line) => LIST_ITEM_PATTERN.exec(line.trim())?.[1])

    // A block renders as a bullet list only when EVERY line in it is a list
    // item — a block that mixes plain lines and "- " lines just falls
    // through to the paragraph case below, `- ` and all, rather than
    // guessing which lines belong to the list.
    if (listItems.every((item) => item !== undefined)) {
      return (
        <ul key={bi} className="list-disc space-y-1 pl-5 text-left">
          {(listItems as string[]).map((item, li) => (
            <li key={li}>{renderInline(item, `${bi}-${li}`)}</li>
          ))}
        </ul>
      )
    }

    return (
      <p key={bi}>
        {lines.map((line, li) => (
          <span key={li}>
            {renderInline(line, `${bi}-${li}`)}
            {li < lines.length - 1 && <br />}
          </span>
        ))}
      </p>
    )
  })
}
