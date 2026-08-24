import type { ReactNode } from 'react'

/**
 * "Light Markdown" (M13 v1 scope) — deliberately not a general-purpose
 * CommonMark engine. Supports paragraphs, **bold**, *italic*, and
 * [label](https://url) links (http/https only). Builds React elements
 * directly rather than parsing to an HTML string, so it is XSS-safe by
 * construction — there is no `dangerouslySetInnerHTML` anywhere in this
 * path and nothing to sanitise.
 */
const INLINE_PATTERN = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

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
  const paragraphs = text.trim().split(/\n\s*\n/).filter(Boolean)
  return paragraphs.map((paragraph, pi) => {
    const lines = paragraph.split('\n')
    return (
      <p key={pi}>
        {lines.map((line, li) => (
          <span key={li}>
            {renderInline(line, `${pi}-${li}`)}
            {li < lines.length - 1 && <br />}
          </span>
        ))}
      </p>
    )
  })
}
