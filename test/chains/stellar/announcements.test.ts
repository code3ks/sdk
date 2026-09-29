import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  fetchAnnouncementsStream,
  RetentionExceededError,
} from '../../../src/chains/stellar/announcements';
import type { Announcement } from '../../../src/chains/stellar/types';

vi.mock('@stellar/stellar-sdk', () => {
  const mockAddress = {
    toString: () => 'GMOCKADDRESS000000000000000000000000000000000000000000000',
  };
  const makeScVal = (overrides: Record<string, unknown> = {}) => ({
    u32: () => 1,
    address: () => ({}),
    vec: () => [
      { address: () => ({}) },
      { bytes: () => new Uint8Array(32).fill(1) },
      { bytes: () => new Uint8Array(1).fill(0x42) },
    ],
    ...overrides,
  });

  return {
    xdr: {
      ScVal: {
        fromXDR: vi.fn((_data: string, _enc: string) => makeScVal()),
        scvSymbol: vi.fn((sym: string) => ({ toXDR: vi.fn(() => `sym:${sym}`) })),
        scvU32: vi.fn((n: number) => ({ toXDR: vi.fn(() => `u32:${n}`) })),
        scvBytes: vi.fn((bytes: Buffer) => ({ toXDR: vi.fn(() => bytes.toString('hex')) })),
        scvVec: vi.fn((vec: unknown[]) => ({ toXDR: vi.fn(() => JSON.stringify(vec)) })),
      },
    },
    Address: {
      fromScAddress: vi.fn(() => mockAddress),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers shared by HEAD-style tests (fetchAnnouncements with options)
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body?: any };
const calls: FetchCall[] = [];

function rpcEnvelope(body: unknown, id: number | null = null): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const data = body as Record<string, unknown>;
  if (data.jsonrpc !== undefined) return body;
  if (
    !Object.prototype.hasOwnProperty.call(data, 'result') &&
    !Object.prototype.hasOwnProperty.call(data, 'error')
  ) {
    return body;
  }
  if (data.error && typeof data.error === 'object' && !Array.isArray(data.error)) {
    data.error = { code: -1, ...(data.error as Record<string, unknown>) };
  }
  return { jsonrpc: '2.0', id, ...data };
}

function jsonResponse(body: unknown) {
  return Promise.resolve({ json: () => Promise.resolve(body) } as Response);
}

function mockFetch(handler: (url: string, body?: any) => unknown) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(init.body.toString()) : undefined;
      calls.push({ url, body });
      return jsonResponse(rpcEnvelope(handler(url, body), body?.id ?? null));
    }),
  );
}

function sorobanRange(oldest = 100, latest = 200) {
  return {
    error: {
      message: `startLedger outside retained range: ${oldest} - ${latest}`,
    },
  };
}

function emptyEvents(cursor = 'next-cursor') {
  return {
    result: {
      events: [],
      cursor,
    },
  };
}

function methodCalls(method: string) {
  return calls.filter((call) => call.body?.method === method);
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers for streaming tests (fetchAnnouncementsStream)
// ---------------------------------------------------------------------------

function makeProbeSuccess() {
  return { result: { events: [{ topic: ['', '', ''], value: '' }] } };
}

function makeProbeRangeError(oldest: number, latest: number) {
  return { error: { message: `range: ${oldest} - ${latest}` } };
}

function makeProbeUnknownError() {
  return { error: { message: 'some unknown error' } };
}

function makeEventsPage(count: number, cursor?: string, startIdx = 0) {
  const events = Array.from({ length: count }, (_, i) => ({
    id: `event-${startIdx + i}`,
    ledger: 1,
    topic: [`topic0_${startIdx + i}`, `topic1_${startIdx + i}`, `topic2_${startIdx + i}`],
    value: `value_${startIdx + i}`,
  }));
  return { result: { events, cursor } };
}

function mockFetchSequence(responses: unknown[]) {
  let call = 0;
  return vi.fn(async () => {
    const body = responses[call++] ?? responses[responses.length - 1];
    return { json: async () => rpcEnvelope(body) } as Response;
  });
}

async function collectStream(gen: AsyncGenerator<Announcement>): Promise<Announcement[]> {
  const out: Announcement[] = [];
  for await (const a of gen) out.push(a);
  return out;
}

// ---------------------------------------------------------------------------
// fetchAnnouncements with FetchAnnouncementsOptions (ledger ranges, cursors, timestamps)
// ---------------------------------------------------------------------------

describe('fetchAnnouncements Stellar ranges', () => {
  test('passes an explicit ledger range to Soroban getEvents', async () => {
    mockFetch((_url, body) => {
      if (body?.id === 0) return sorobanRange();
      return {
        result: {
          events: [
            ...Array.from({ length: 999 }, (_, i) => ({
              id: `range-event-${i}`,
              ledger: 174,
              topic: ['topic0', 'topic1', 'topic2'],
              value: 'value',
            })),
            { id: 'range-end', ledger: 175, topic: ['topic0', 'topic1', 'topic2'], value: 'value' },
          ],
          cursor: 'range-cursor',
        },
      };
    });

    const result = await collectStream(
      fetchAnnouncementsStream('stellar', { fromLedger: 150, toLedger: 175 }),
    );
    const scan = methodCalls('getEvents')[1].body.params;

    expect(scan.startLedger).toBe(150);
    expect(scan.pagination).toEqual({ limit: 1000 });
    expect(result).toHaveLength(999);
    expect(methodCalls('getEvents')).toHaveLength(2);
  });

  test('uses cursor pagination instead of fromLedger when both are provided', async () => {
    mockFetch((_url, body) => {
      if (body?.id === 0) return sorobanRange();
      return emptyEvents('resume-cursor');
    });

    await collectStream(
      fetchAnnouncementsStream('stellar', { fromLedger: 150, cursor: 'previous-cursor' }),
    );
    const scan = methodCalls('getEvents')[1].body.params;

    expect(scan.startLedger).toBeUndefined();
    expect(scan.pagination).toEqual({ limit: 1000, cursor: 'previous-cursor' });
  });

  test('converts timestamps to inclusive and exclusive ledger bounds through Horizon', async () => {
    const sorobanUrl = 'https://soroban-testnet.stellar.org';
    const horizonUrl = 'https://horizon-testnet.stellar.org';

    mockFetch((url, body) => {
      if (url === sorobanUrl && body?.id === 0) return sorobanRange(1, 8);
      if (url === sorobanUrl) return emptyEvents();
      if (url === `${horizonUrl}/ledgers?order=desc&limit=1`) {
        return { _embedded: { records: [{ sequence: 8, closed_at: '2026-01-01T00:08:00Z' }] } };
      }
      const sequence = Number(url.split('/').pop());
      return {
        sequence,
        closed_at: `2026-01-01T00:${sequence.toString().padStart(2, '0')}:00Z`,
      };
    });

    await collectStream(
      fetchAnnouncementsStream('stellar', {
        fromTimestamp: new Date('2026-01-01T00:04:00Z'),
        toTimestamp: new Date('2026-01-01T00:07:00Z'),
      }),
    );

    const scan = methodCalls('getEvents')[1].body.params;
    expect(scan.startLedger).toBe(4);
  });

  test('throws a typed error when requested fromLedger predates Soroban retention', async () => {
    mockFetch((_url, body) => {
      if (body?.id === 0) return sorobanRange(100, 200);
      return emptyEvents();
    });

    await expect(
      (async () => {
        for await (const _ of fetchAnnouncementsStream('stellar', { fromLedger: 99 })) {
        }
      })(),
    ).rejects.toMatchObject({
      name: 'RetentionExceededError',
      requestedLedger: 99,
      oldestAvailableLedger: 100,
    } satisfies Partial<RetentionExceededError>);
  });

  test('rejects ambiguous ledger and timestamp lower bounds', async () => {
    await expect(
      (async () => {
        for await (const _ of fetchAnnouncementsStream('stellar', {
          fromLedger: 10,
          fromTimestamp: new Date('2026-01-01T00:00:00Z'),
        })) {
        }
      })(),
    ).rejects.toThrow('fromLedger and fromTimestamp are mutually exclusive');
  });
});

// ---------------------------------------------------------------------------
// fetchAnnouncementsStream (streaming generator)
// ---------------------------------------------------------------------------

describe('fetchAnnouncementsStream', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = mockFetchSequence([]);
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('rejects a malformed JSON-RPC envelope with endpoint context', async () => {
    const endpoint = 'https://malformed-rpc.example.test/';
    fetchSpy = vi.fn(async () => ({ json: async () => ({ result: { events: [] } }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      collectStream(fetchAnnouncementsStream('stellar', { sorobanUrl: endpoint })),
    ).rejects.toMatchObject({
      name: 'AnnouncementParseError',
      endpoint,
      field: 'jsonrpc',
    });
  });

  test('yields announcements from a single page', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      makeEventsPage(3),
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(fetchAnnouncementsStream('stellar', { includeV2: false }));
    expect(results.length).toBe(3);
    expect(results[0]).toMatchObject({ schemeId: 1 });
  });

  test('follows cursor across multiple pages', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      makeEventsPage(1000, 'cursor-abc', 0),
      makeEventsPage(5, undefined, 1000),
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(fetchAnnouncementsStream('stellar', { includeV2: false }));
    expect(results.length).toBe(1005);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    const secondPageBody = JSON.parse(fetchSpy.mock.calls[3][1].body);
    expect(secondPageBody.params.pagination.cursor).toBe('cursor-abc');
  });

  test('adjusts startLedger from probe range error', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    fetchSpy = mockFetchSequence([makeProbeRangeError(1000, 6500), makeEventsPage(2)]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(fetchAnnouncementsStream('stellar', { includeV2: false }));
    expect(results.length).toBe(2);

    const pageBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(pageBody.params.startLedger).toBe(1500); // max(1000, 6500-5000)
  });

  test('returns empty stream on unrecoverable probe error', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    fetchSpy = mockFetchSequence([
      makeProbeUnknownError(),
      { result: { sequence: 100 } },
      emptyEvents(),
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(fetchAnnouncementsStream('stellar', { includeV2: false }));
    expect(results).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test('stops when page has fewer than 1000 events and no cursor', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      makeEventsPage(500),
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    await collectStream(fetchAnnouncementsStream('stellar', { includeV2: false }));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test('uses sorobanUrl override', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    const customUrl = 'https://custom-rpc.example.com';
    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      makeEventsPage(1),
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    await collectStream(
      fetchAnnouncementsStream('stellar', { sorobanUrl: customUrl, includeV2: false }),
    );
    expect(fetchSpy.mock.calls[0][0]).toBe(customUrl);
  });

  test('cancellation: stops after yielding first item', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      makeEventsPage(1000, 'cursor-next'),
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const results: Announcement[] = [];
    for await (const ann of fetchAnnouncementsStream('stellar', { includeV2: false })) {
      results.push(ann);
      break;
    }

    expect(results).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // first page only
  });
});

// ---------------------------------------------------------------------------
// Cross-chunk deduplication tests
// ---------------------------------------------------------------------------

describe('cross-chunk deduplication', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = mockFetchSequence([]);
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeEventWithIdentity(txHash: string, ledger: number, idx: number) {
    return {
      id: `${String(ledger).padStart(10, '0')}-${String(idx).padStart(10, '0')}`,
      txHash,
      ledger,
      contractId: 'CTEST123',
      topic: [`topic0_${idx}`, `topic1_${idx}`, `topic2_${idx}`],
      value: `value_${idx}`,
    };
  }

  test('deduplicates identical events across multiple pages', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    // Same event appearing in two pages with different provider IDs - but same ledger-eventIndex
    const duplicateEvent = makeEventWithIdentity('duplicate-tx', 100, 1);
    const page1 = { result: { events: [duplicateEvent], cursor: 'cursor-1' } };
    // Same id means same event (ledger-eventIndex format)
    const page2 = { result: { events: [{ ...duplicateEvent }] } };

    fetchSpy = mockFetchSequence([makeProbeSuccess(), { result: { sequence: 100 } }, page1, page2]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(fetchAnnouncementsStream('stellar', { includeV2: false }));

    // Should only get 1 announcement, not 2
    expect(results).toHaveLength(1);
  });

  test('accepts seenEventIds to skip previously processed events', async () => {
    const { fetchAnnouncementsStream, computeEventIdentity } =
      await import('../../../src/chains/stellar/announcements');

    const event1 = makeEventWithIdentity('tx1', 100, 1);
    const event2 = makeEventWithIdentity('tx2', 100, 2);
    const event3 = makeEventWithIdentity('tx3', 100, 3);

    // Compute identity for event1 to simulate it was seen in a previous chunk
    const identity1 = computeEventIdentity(event1);
    const seenIds = new Set<string>();
    if (identity1) seenIds.add(identity1.id);

    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      { result: { events: [event1, event2, event3] } },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(
      fetchAnnouncementsStream('stellar', { includeV2: false, seenEventIds: seenIds }),
    );

    // Should only get 2 announcements (event2 and event3), event1 was filtered
    expect(results).toHaveLength(2);
  });

  test('accumulates seen events across streaming pages', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    const event1 = makeEventWithIdentity('tx1', 100, 1);
    const event2 = makeEventWithIdentity('tx2', 100, 2);

    // event1 appears in both pages
    const page1 = { result: { events: [event1, event2], cursor: 'cursor-1' } };
    const page2 = { result: { events: [event1] } };

    fetchSpy = mockFetchSequence([makeProbeSuccess(), { result: { sequence: 100 } }, page1, page2]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(fetchAnnouncementsStream('stellar', { includeV2: false }));

    // Should only get 2 unique announcements, even though event1 appeared twice
    expect(results).toHaveLength(2);
  });

  test('handles v1 and v2 events with separate identities', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    // Same txHash but different topics (v1 vs v2) and different event indices
    const v1Event = {
      id: '0000000100-0000000001',
      txHash: 'shared-tx',
      ledger: 100,
      contractId: 'CTEST',
      topic: ['v1-topic-1', 'v1-topic-2', 'v1-topic-3'],
      value: 'v1-value',
    };

    const v2Event = {
      id: '0000000100-0000000002',
      txHash: 'shared-tx',
      ledger: 100,
      contractId: 'CTEST',
      topic: ['v2-topic-1', 'v2-topic-2', 'v2-topic-3', 'v2-topic-4'],
      value: 'v2-value',
    };

    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      { result: { events: [v1Event, v2Event] } },
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(fetchAnnouncementsStream('stellar'));

    // Both events should be included since they have different identities
    expect(results).toHaveLength(2);
  });

  test('deduplicates across filter group boundaries', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    const sharedEvent = makeEventWithIdentity('shared-tx', 100, 1);

    // Same event in both v1 and v2 filter groups (same ledger-eventIndex)
    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      { result: { events: [sharedEvent] } }, // v1 filter
      { result: { events: [sharedEvent] } }, // v2 filter
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(fetchAnnouncementsStream('stellar'));

    // Should only get 1 announcement despite appearing in both filter groups
    expect(results).toHaveLength(1);
  });

  test('maintains deduplication state when using viewTagBuckets', async () => {
    const { fetchAnnouncementsStream } = await import('../../../src/chains/stellar/announcements');

    const event1 = makeEventWithIdentity('tx1', 100, 1);
    const event2 = makeEventWithIdentity('tx2', 100, 2);

    // Simulate event1 appearing in multiple bucket queries
    fetchSpy = mockFetchSequence([
      makeProbeSuccess(),
      { result: { sequence: 100 } },
      { result: { events: [event1] } }, // bucket 0
      { result: { events: [event1, event2] } }, // bucket 1 (overlaps with bucket 0)
    ]);
    vi.stubGlobal('fetch', fetchSpy);

    const results = await collectStream(
      fetchAnnouncementsStream('stellar', { viewTagBuckets: [0, 1] }),
    );

    // Should get 2 unique events, not 3
    expect(results).toHaveLength(2);
  });
});
