/**
 * Pure parsing of the Notification 2.0 consumer wire protocol.
 *
 * A frame is UTF-8 text: one or more header lines separated by `\n`, then a
 * blank line (`\n\n`), then the payload body.
 *
 *   <ackHeader>\n
 *   /<tenantId>/<type>/<sourceId>\n
 *   <ACTION>\n
 *   [extra headers...]\n
 *   \n
 *   <payload>
 */
import type { NotificationDescription } from './types'

/**
 * The header/payload split of a raw frame, before payload JSON parsing.
 */
export interface ParsedFrame {
  ackHeader: string
  description: NotificationDescription
  action: string
  extraHeaders: string[]
  rawPayload: string
}

/**
 * Parse the notification description header
 * (`/{tenantId}/{type}/{sourceId}`) into its parts. Tolerates a missing
 * leading slash and extra path segments (the remainder is kept as `sourceId`).
 * @param line
 */
export function parseDescription(line: string): NotificationDescription {
  const withoutLeadingSlash = line.startsWith('/') ? line.slice(1) : line
  const parts = withoutLeadingSlash.split('/')
  const [tenantId = '', type = '', ...rest] = parts
  return {
    tenantId,
    type,
    sourceId: rest.join('/'),
    raw: line,
  }
}

/**
 * Split a raw consumer frame into headers and payload.
 *
 * @param raw
 * @throws never — returns `undefined` for frames that lack a usable
 * acknowledgement header, so the caller can skip them without crashing.
 */
export function parseFrame(raw: string): ParsedFrame | undefined {
  // Normalize CRLF just in case a proxy rewrote line endings.
  const normalized = raw.replace(/\r\n/g, '\n')
  const separatorIndex = normalized.indexOf('\n\n')

  const headerBlock = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex)
  const rawPayload = separatorIndex === -1 ? '' : normalized.slice(separatorIndex + 2)

  const headerLines = headerBlock.split('\n')
  const ackHeader = headerLines[0]?.trim() ?? ''
  if (ackHeader.length === 0)
    return undefined

  const descriptionLine = headerLines[1] ?? ''
  const action = (headerLines[2] ?? '').trim()
  const extraHeaders = headerLines.slice(3).filter((l) => l.length > 0)

  return {
    ackHeader,
    description: parseDescription(descriptionLine),
    action,
    extraHeaders,
    rawPayload,
  }
}

/**
 * Best-effort JSON parse of a payload string. Returns the parsed value, or the
 * raw string when it is not valid JSON.
 * @param rawPayload
 */
export function parsePayload(rawPayload: string): unknown {
  const trimmed = rawPayload.trim()
  if (trimmed.length === 0)
    return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return rawPayload
  }
}
