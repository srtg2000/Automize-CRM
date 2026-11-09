import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseAdmin = vi.fn();
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => supabaseAdmin(),
}));

import { POST } from './route';

function createAdmin({
  webinar = {
    account_id: 'account-1',
    start_time: '2030-01-02T00:00:00.000Z',
    reminder_rules: [
      {
        id: 'day',
        offset_minutes: -1440,
        label: 'Day before',
        template_name: 'day',
        enabled: true,
      },
      {
        id: 'hour',
        offset_minutes: -60,
        label: 'Hour before',
        template_name: 'hour',
        enabled: true,
      },
      {
        id: 'live',
        offset_minutes: 0,
        label: 'At start',
        template_name: 'live',
        enabled: true,
      },
      {
        id: 'after',
        offset_minutes: 120,
        label: 'After',
        template_name: 'after',
        enabled: true,
      },
    ],
  },
  webinarError = null,
  registrant = { id: 'registrant-1' },
  registrantError = null,
  queueError = null,
  rateLimitResult = true,
  rateLimitError = null,
}: {
  webinar?: {
    account_id?: string;
    start_time: string;
    reminder_rules?: unknown;
    webhook_secret_hash?: string | null;
  } | null;
  webinarError?: { message: string } | null;
  registrant?: { id: string } | null;
  registrantError?: { message: string } | null;
  queueError?: { message: string } | null;
  rateLimitResult?: boolean;
  rateLimitError?: { message: string } | null;
} = {}) {
  const calls = { upsert: vi.fn(), insert: vi.fn() };
  const webinarQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValue({ data: webinar, error: webinarError }),
  };
  const registrantQuery = {
    upsert: calls.upsert.mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi
      .fn()
      .mockResolvedValue({ data: registrant, error: registrantError }),
  };
  const deleteQuery = { eq: vi.fn() };
  deleteQuery.eq
    .mockReturnValueOnce(deleteQuery)
    .mockReturnValueOnce(deleteQuery)
    .mockResolvedValueOnce({ error: null });
  const queueQuery = {
    delete: vi.fn(() => deleteQuery),
    insert: calls.insert.mockResolvedValue({ error: queueError }),
  };

  const admin = {
    rpc: vi.fn().mockResolvedValue({
      data: rateLimitResult,
      error: rateLimitError,
    }),
    from: vi.fn((table: string) => {
      if (table === 'webinars') return webinarQuery;
      if (table === 'webinar_registrants') return registrantQuery;
      if (table === 'webinar_campaign_queue') return queueQuery;
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
  return { admin, calls };
}

function post(payload: unknown, webinarId?: string) {
  return POST(
    new Request(
      `http://localhost/api/webhooks/sheets-ingest${
        webinarId ? `?webinar_id=${encodeURIComponent(webinarId)}` : ''
      }`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-secret': 'sheets-test-secret',
        },
        body: JSON.stringify(payload),
      }
    )
  );
}

describe('POST /api/webhooks/sheets-ingest', () => {
  beforeEach(() => {
    vi.useRealTimers();
    process.env.SHEETS_INGEST_SECRET = 'sheets-test-secret';
  });

  it('validates required fields and international phone format', async () => {
    const missingFields = await post({ webinar_id: 'webinar-1' });
    expect(missingFields.status).toBe(400);

    const missingCountryCode = await post({
      webinar_id: 'webinar-1',
      phone: '4155550123',
    });
    expect(missingCountryCode.status).toBe(400);
    expect(supabaseAdmin).not.toHaveBeenCalled();
  });

  it('upserts a normalized registrant and queues future triggers only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const { admin, calls } = createAdmin();
    supabaseAdmin.mockReturnValue(admin);

    const response = await post({
      webinar_id: 'webinar-1',
      name: ' Jane Doe ',
      phone: '+1 (415) 555-0123',
      custom_data: { source: 'sheets' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      registrant_id: 'registrant-1',
      scheduled_count: 3,
    });
    expect(calls.upsert).toHaveBeenCalledWith(
      {
        webinar_id: 'webinar-1',
        account_id: 'account-1',
        phone: '14155550123',
        name: 'Jane Doe',
        custom_data: { source: 'sheets' },
      },
      { onConflict: 'webinar_id,phone' }
    );
    expect(calls.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        trigger_type: 'hour',
        scheduled_for: '2030-01-01T23:00:00.000Z',
        status: 'pending',
      }),
      expect.objectContaining({
        trigger_type: 'live',
        scheduled_for: '2030-01-02T00:00:00.000Z',
        status: 'pending',
      }),
      expect.objectContaining({
        trigger_type: 'after',
        scheduled_for: '2030-01-02T02:00:00.000Z',
        status: 'pending',
      }),
    ]);
  });

  it('returns 404 when the webinar does not exist', async () => {
    const { admin } = createAdmin({ webinar: null });
    supabaseAdmin.mockReturnValue(admin);

    const response = await post({
      webinar_id: 'missing',
      phone: '+14155550123',
    });

    expect(response.status).toBe(404);
  });

  it('rejects unauthorized requests before rate limiting or writes', async () => {
    const { admin } = createAdmin();
    supabaseAdmin.mockReturnValue(admin);

    const response = await POST(
      new Request(
        'http://localhost/api/webhooks/sheets-ingest?webinar_id=webinar-1',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone: '+14155550123' }),
        }
      )
    );

    expect(response.status).toBe(401);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('rejects requests over the webinar rate limit', async () => {
    const { admin, calls } = createAdmin({ rateLimitResult: false });
    supabaseAdmin.mockReturnValue(admin);

    const response = await post(
      { webinar_id: 'webinar-1', phone: '+14155550123' },
      'webinar-1'
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(calls.upsert).not.toHaveBeenCalled();
  });

  it('accepts a secret matching the stored webinar hash', async () => {
    const secret = 'webinar-secret-that-is-long-enough-to-use';
    const crypto = await import('node:crypto');
    const { admin, calls } = createAdmin({
      webinar: {
        account_id: 'account-1',
        start_time: '2030-01-02T00:00:00.000Z',
        reminder_rules: [],
        webhook_secret_hash: crypto
          .createHash('sha256')
          .update(secret)
          .digest('hex'),
      },
    });
    supabaseAdmin.mockReturnValue(admin);

    const response = await POST(
      new Request(
        'http://localhost/api/webhooks/sheets-ingest?webinar_id=webinar-1',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-webhook-secret': secret,
          },
          body: JSON.stringify({ phone: '+14155550123' }),
        }
      )
    );

    expect(response.status).toBe(200);
    expect(calls.upsert).toHaveBeenCalled();
  });

  it('uses the webinar id from the shareable URL and rejects conflicting payload ids', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const { admin, calls } = createAdmin();
    supabaseAdmin.mockReturnValue(admin);

    const response = await post({ phone: '+14155550123' }, 'webinar-from-url');

    expect(response.status).toBe(200);
    expect(calls.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ webinar_id: 'webinar-from-url' }),
      { onConflict: 'webinar_id,phone' }
    );

    const mismatch = await post(
      { webinar_id: 'other-webinar', phone: '+14155550123' },
      'webinar-from-url'
    );
    expect(mismatch.status).toBe(400);
  });

  it('schedules no messages when the webinar has no configured reminders', async () => {
    const { admin, calls } = createAdmin({
      webinar: {
        start_time: '2030-01-02T00:00:00.000Z',
        reminder_rules: [],
      },
    });
    supabaseAdmin.mockReturnValue(admin);

    const response = await post({
      webinar_id: 'webinar-1',
      phone: '+14155550123',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduled_count: 0,
    });
    expect(calls.insert).not.toHaveBeenCalled();
  });

  it('returns 500 if the queue cannot be written', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const { admin } = createAdmin({
      queueError: { message: 'database unavailable' },
    });
    supabaseAdmin.mockReturnValue(admin);

    const response = await post({
      webinar_id: 'webinar-1',
      phone: '+14155550123',
    });

    expect(response.status).toBe(500);
  });
});
