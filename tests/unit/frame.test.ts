import { describe, expect, it } from 'vitest'
import { parseDescription, parseFrame, parsePayload } from '../../src/frame'

const SAMPLE = [
  'CJ1eEAAgADAB',
  '/tenant-a170/managedobjects/111',
  'CREATE',
  '',
  '{"id":"111","name":"a switch"}',
].join('\n')

describe('parseDescription', () => {
  it('splits the /tenant/type/source description header', () => {
    const d = parseDescription('/tenant-a170/measurements/111')
    expect(d).toEqual({
      tenantId: 'tenant-a170',
      type: 'measurements',
      sourceId: '111',
      raw: '/tenant-a170/measurements/111',
    })
  })

  it('keeps any extra path segments as part of the source id', () => {
    const d = parseDescription('/t1/events/a/b/c')
    expect(d.type).toBe('events')
    expect(d.sourceId).toBe('a/b/c')
  })
})

describe('parseFrame', () => {
  it('extracts ack id, description, action and payload', () => {
    const frame = parseFrame(SAMPLE)
    expect(frame).toBeDefined()
    expect(frame?.ackHeader).toBe('CJ1eEAAgADAB')
    expect(frame?.description.type).toBe('managedobjects')
    expect(frame?.description.sourceId).toBe('111')
    expect(frame?.action).toBe('CREATE')
    expect(frame?.rawPayload).toBe('{"id":"111","name":"a switch"}')
  })

  it('captures extra headers beyond the first three', () => {
    const frame = parseFrame(['ACK1', '/t/alarms/1', 'UPDATE', 'X-Extra: 1', '', 'body'].join('\n'))
    expect(frame?.extraHeaders).toEqual(['X-Extra: 1'])
  })

  it('tolerates CRLF line endings', () => {
    const frame = parseFrame(SAMPLE.replace(/\n/g, '\r\n'))
    expect(frame?.ackHeader).toBe('CJ1eEAAgADAB')
    expect(frame?.rawPayload).toContain('a switch')
  })

  it('returns undefined for a frame without an ack header', () => {
    expect(parseFrame('')).toBeUndefined()
    expect(parseFrame('\n\nbody')).toBeUndefined()
  })
})

describe('parsePayload', () => {
  it('parses JSON payloads', () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 })
  })

  it('returns the raw string for non-JSON payloads', () => {
    expect(parsePayload('not json')).toBe('not json')
  })

  it('returns undefined for empty payloads', () => {
    expect(parsePayload('   ')).toBeUndefined()
  })
})
