/**
 * CSV export (AROS-64) — generic, RFC 4180 shaped, used by every report.
 *
 * Nothing here knows what a revenue row is: a caller passes rows plus a column
 * spec, so the same helper serves the revenue, booking, food, membership and
 * employee exports (AROS-65/66/67) without a second implementation appearing.
 *
 * ── ESCAPING RULES (RFC 4180) ───────────────────────────────────────────────
 *   * A field is quoted when it contains the delimiter, a double quote, CR or
 *     LF, or has leading/trailing whitespace a spreadsheet would otherwise eat.
 *   * A double quote inside a quoted field is doubled: `Asha "the boss"` →
 *     `"Asha ""the boss"""`.
 *   * Newlines are kept verbatim INSIDE the quotes — a multi-line note stays
 *     one field, which is why quoting rather than stripping is correct.
 *   * null / undefined → an empty field, distinct from the string "null".
 *   * Numbers are written unquoted and unformatted (no thousands separators,
 *     no currency symbol) so the value stays numeric when the file is opened.
 *     A non-finite number (NaN/Infinity) has no CSV meaning and is written as
 *     empty rather than as the literal "NaN".
 *
 * Rows are terminated with CRLF, which is what RFC 4180 specifies and what
 * Excel is happiest with; every other tool accepts it.
 *
 * ── A NOTE ON SPREADSHEET FORMULAS ──────────────────────────────────────────
 * A field beginning `=`, `+`, `-` or `@` may be executed as a formula by Excel
 * and Sheets. This helper does NOT mangle such values, because silently
 * rewriting exported data is its own bug (a negative amount starts with `-`).
 * If a future export includes free text an outsider can set — a customer's own
 * note, say — prefix it at the column level there, where the trade-off is
 * visible.
 */

/** How one column is named and how a row yields its value. */
export type CsvColumn<T> = {
  header: string
  value: (row: T) => CsvValue
}

export type CsvValue = string | number | boolean | Date | null | undefined

export type CsvOptions = {
  /** Field separator. ',' unless a locale needs ';'. */
  delimiter?: string
  /** Row terminator. CRLF per RFC 4180. */
  eol?: string
  /** Emit the header row. Default true. */
  header?: boolean
  /**
   * Prepend a UTF-8 byte-order mark. Excel needs it to read non-ASCII (₹, a
   * customer's name in Devanagari) as UTF-8 rather than as the system
   * codepage. Off by default so machine consumers get clean bytes; turn it on
   * for a browser download.
   */
  bom?: boolean
}

const DEFAULTS = { delimiter: ',', eol: '\r\n', header: true, bom: false } as const

/** U+FEFF, written as an escape so no editor or transcode can eat it. */
export const UTF8_BOM = '﻿'

/** One field, escaped and quoted only when it has to be. */
export function escapeCsvValue(value: CsvValue, delimiter: string = DEFAULTS.delimiter): string {
  if (value === null || value === undefined) return ''

  let text: string
  if (typeof value === 'number') {
    // Excludes NaN and ±Infinity — see the note above.
    text = Number.isFinite(value) ? String(value) : ''
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false'
  } else if (value instanceof Date) {
    // ISO 8601 UTC: unambiguous, sorts correctly, and never depends on the
    // exporting machine's zone. Reports that want a tenant-local day should
    // pass an already-formatted `YYYY-MM-DD` string instead.
    text = Number.isNaN(value.getTime()) ? '' : value.toISOString()
  } else {
    text = value
  }

  if (text === '') return ''

  const mustQuote =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text !== text.trim()

  return mustQuote ? `"${text.replaceAll('"', '""')}"` : text
}

/** One row of already-extracted values, joined and escaped. */
export function csvRow(values: readonly CsvValue[], options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? DEFAULTS.delimiter
  return values.map((v) => escapeCsvValue(v, delimiter)).join(delimiter)
}

/**
 * The whole file as one string. Fine for a report a human asked for; for an
 * unbounded export use csvLines()/csvStream() so the rows are never all in
 * memory at once.
 */
export function toCsv<T>(rows: Iterable<T>, columns: readonly CsvColumn<T>[], options: CsvOptions = {}): string {
  const eol = options.eol ?? DEFAULTS.eol
  // The BOM is emitted by csvLines() with the header — not here, or it would
  // be written twice.
  let out = ''
  for (const line of csvLines(rows, columns, options)) out += line + eol
  return out
}

/**
 * The file as a lazy sequence of lines (no terminators), header first.
 *
 * Generator rather than an array so a large result set is formatted a row at a
 * time. The BOM, if asked for, is folded into the header line — it belongs at
 * the very start of the file and nowhere else.
 */
export function* csvLines<T>(
  rows: Iterable<T>,
  columns: readonly CsvColumn<T>[],
  options: CsvOptions = {},
): Generator<string> {
  const withHeader = options.header ?? DEFAULTS.header
  if (withHeader) {
    const header = csvRow(
      columns.map((c) => c.header),
      options,
    )
    yield options.bom ? UTF8_BOM + header : header
  }
  for (const row of rows) {
    yield csvRow(
      columns.map((c) => c.value(row)),
      options,
    )
  }
}

/**
 * The file as a web ReadableStream of UTF-8 bytes, for a Route Handler that
 * streams an export instead of buffering it:
 *
 *     return new Response(csvStream(rows, cols), { headers: csvDownloadHeaders('revenue.csv') })
 *
 * Accepts a sync OR async iterable, so a future cursor-based reader can feed
 * it directly without materialising every row.
 */
export function csvStream<T>(
  rows: Iterable<T> | AsyncIterable<T>,
  columns: readonly CsvColumn<T>[],
  options: CsvOptions = {},
): ReadableStream<Uint8Array> {
  const eol = options.eol ?? DEFAULTS.eol
  const encoder = new TextEncoder()
  const iterator = isAsyncIterable(rows) ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]()
  const withHeader = options.header ?? DEFAULTS.header
  let headerPending = withHeader

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (headerPending) {
        headerPending = false
        const header = csvRow(
          columns.map((c) => c.header),
          options,
        )
        controller.enqueue(encoder.encode((options.bom ? UTF8_BOM : '') + header + eol))
        return
      }
      const next = await iterator.next()
      if (next.done) {
        controller.close()
        return
      }
      controller.enqueue(
        encoder.encode(
          csvRow(
            columns.map((c) => c.value(next.value)),
            options,
          ) + eol,
        ),
      )
    },
  })
}

/** Response headers that make a browser save the body as `filename`. */
export function csvDownloadHeaders(filename: string): Record<string, string> {
  // Quotes + doubled quotes, same rule as a CSV field, so a filename with a
  // quote or a space cannot break out of the header.
  const safe = filename.replaceAll('"', '')
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safe}"`,
    // An export is a snapshot of live data; never let a proxy serve a stale one.
    'Cache-Control': 'no-store',
  }
}

function isAsyncIterable<T>(v: Iterable<T> | AsyncIterable<T>): v is AsyncIterable<T> {
  return typeof (v as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
}
