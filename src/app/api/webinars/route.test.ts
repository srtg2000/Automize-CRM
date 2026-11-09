import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRole = vi.fn();
const toErrorResponse = vi.fn((error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : 'error' },
    { status: 500 }
  )
);
const createAdminClient = vi.fn();

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
  toErrorResponse: (error: unknown) => toErrorResponse(error),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => createAdminClient(),
}));

import { GET, PATCH, POST } from './route';

const accountContext = { accountId: 'account-1', userId: 'user-1' };

function createAdmin() {
  const webinarRow = {
    id: 'webinar-1',
    title: 'AI Masterclass',
    start_time: '2030-01-02T18:00:00.000Z',
    join_link: 'https://example.com/join',
    recording_link: null,
    offer_link: null,
    reminder_rules: [],
  };
  const webinarQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [webinarRow], error: null }),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: webinarRow, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: webinarRow, error: null }),
  };
  const registrantQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi
      .fn()
      .mockResolvedValue({ data: [{ id: 'registrant-1' }], error: null }),
    in: vi.fn().mockResolvedValue({
      data: [{ webinar_id: 'webinar-1' }, { webinar_id: 'webinar-1' }],
      error: null,
    }),
  };
  const queueQuery = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({
      data: [
        { webinar_id: 'webinar-1', status: 'sent' },
        { webinar_id: 'webinar-1', status: 'failed' },
      ],
      error: null,
    }),
    delete: vi.fn(() => ({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    })),
    insert: vi.fn().mockResolvedValue({ error: null }),
  };
  const templatesQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({
      data: [{ name: 'approved_template', language: 'en_US' }],
      error: null,
    }),
  };
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'webinars') return webinarQuery;
      if (table === 'webinar_registrants') return registrantQuery;
      if (table === 'webinar_campaign_queue') return queueQuery;
      if (table === 'message_templates') return templatesQuery;
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
  return { admin, webinarQuery, registrantQuery, queueQuery, templatesQuery };
}

describe('/api/webinars', () => {
  beforeEach(() => {
    requireRole.mockResolvedValue(accountContext);
  });

  it('lists only the current account webinars with registrant and sent-message counts', async () => {
    const { admin, webinarQuery } = createAdmin();
    createAdminClient.mockReturnValue(admin);

    const response = await GET();

    expect(requireRole).toHaveBeenCalledWith('viewer');
    expect(admin.from).toHaveBeenCalledWith('webinars');
    expect(webinarQuery.eq).toHaveBeenCalledWith('account_id', 'account-1');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      webinars: [
        {
          id: 'webinar-1',
          title: 'AI Masterclass',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'https://example.com/join',
          recording_link: null,
          offer_link: null,
          reminder_rules: [],
          registered_count: 2,
          messages_sent_count: 1,
        },
      ],
    });
  });

  it('creates a webinar scoped to the current account after agent authorization', async () => {
    const { admin, webinarQuery } = createAdmin();
    createAdminClient.mockReturnValue(admin);

    const response = await POST(
      new Request('http://localhost/api/webinars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: ' AI Masterclass ',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'https://example.com/join',
        }),
      })
    );

    expect(requireRole).toHaveBeenCalledWith('agent');
    expect(webinarQuery.insert).toHaveBeenCalledWith({
      account_id: 'account-1',
      title: 'AI Masterclass',
      start_time: '2030-01-02T18:00:00.000Z',
      join_link: 'https://example.com/join',
      recording_link: null,
      offer_link: null,
      reminder_rules: [],
    });
    expect(response.status).toBe(201);
  });

  it('stores only the hash of a configured webhook secret', async () => {
    const secret = 'a-long-random-secret-with-at-least-32-chars';
    const { admin, webinarQuery } = createAdmin();
    createAdminClient.mockReturnValue(admin);

    const response = await POST(
      new Request('http://localhost/api/webinars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: '550e8400-e29b-41d4-a716-446655440000',
          webhook_secret: secret,
          title: 'AI Masterclass',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'https://example.com/join',
        }),
      })
    );

    expect(response.status).toBe(201);
    expect(webinarQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '550e8400-e29b-41d4-a716-446655440000',
        webhook_secret_hash: expect.any(String),
      })
    );
    const inserted = vi.mocked(webinarQuery.insert).mock.calls[0][0];
    expect(inserted).not.toHaveProperty('webhook_secret');
    expect(inserted.webhook_secret_hash).toBe(
      (await import('node:crypto'))
        .createHash('sha256')
        .update(secret)
        .digest('hex')
    );
  });

  it('rejects invalid URLs before writing', async () => {
    const { admin, webinarQuery } = createAdmin();
    createAdminClient.mockReturnValue(admin);

    const response = await POST(
      new Request('http://localhost/api/webinars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'AI Masterclass',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'javascript:alert(1)',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(webinarQuery.insert).not.toHaveBeenCalled();
  });

  it('returns the exact Supabase error for a webinar list query failure', async () => {
    const { admin } = createAdmin();
    const queryError = { message: 'webinar list query failed' };
    vi.mocked(admin.from).mockImplementation((table: string) => {
      if (table === 'webinars') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({ data: null, error: queryError }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    createAdminClient.mockReturnValue(admin);

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: queryError.message,
    });
  });

  it('returns the exact Supabase error for a webinar insert failure', async () => {
    const { admin, webinarQuery } = createAdmin();
    const queryError = { message: 'webinar insert query failed' };
    webinarQuery.single.mockResolvedValueOnce({
      data: null,
      error: queryError,
    });
    createAdminClient.mockReturnValue(admin);

    const response = await POST(
      new Request('http://localhost/api/webinars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'AI Masterclass',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'https://example.com/join',
        }),
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: queryError.message,
    });
  });

  it('does not insert an unscoped webinar if the workspace account is missing', async () => {
    const { admin, webinarQuery } = createAdmin();
    requireRole.mockResolvedValueOnce({ ...accountContext, accountId: null });
    createAdminClient.mockReturnValue(admin);

    const response = await POST(
      new Request('http://localhost/api/webinars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'AI Masterclass',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'https://example.com/join',
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(webinarQuery.insert).not.toHaveBeenCalled();
  });

  it('updates webinar rules and replaces its pending schedule for current registrants', async () => {
    const { admin, webinarQuery, queueQuery } = createAdmin();
    createAdminClient.mockReturnValue(admin);

    const response = await PATCH(
      new Request('http://localhost/api/webinars', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'webinar-1',
          title: 'Updated Webinar',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'https://example.com/join',
          recording_link: null,
          offer_link: null,
          reminder_rules: [
            {
              id: 'rule-live',
              offset_minutes: 0,
              label: 'At webinar time',
              template_name: 'approved_template',
              template_language: 'en_US',
              enabled: true,
            },
          ],
        }),
      })
    );

    expect(requireRole).toHaveBeenCalledWith('agent');
    expect(webinarQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Updated Webinar',
        reminder_rules: [
          expect.objectContaining({
            id: 'rule-live',
            template_name: 'approved_template',
          }),
        ],
      })
    );
    expect(queueQuery.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        webinar_id: 'webinar-1',
        registrant_id: 'registrant-1',
        trigger_type: 'rule-live',
        scheduled_for: expect.any(String),
        status: 'pending',
      }),
    ]);
    expect(response.status).toBe(200);
  });

  it('rejects invalid reminder rules before inserting a webinar', async () => {
    const { admin, webinarQuery } = createAdmin();
    createAdminClient.mockReturnValue(admin);

    const response = await POST(
      new Request('http://localhost/api/webinars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'AI Masterclass',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'https://example.com/join',
          reminder_rules: [{ id: 'rule', offset_minutes: 1.5 }],
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(webinarQuery.insert).not.toHaveBeenCalled();
  });

  it('rejects a reminder mapped to a template that is not approved', async () => {
    const { admin, webinarQuery, templatesQuery } = createAdmin();
    templatesQuery.in.mockResolvedValueOnce({ data: [], error: null });
    createAdminClient.mockReturnValue(admin);

    const response = await POST(
      new Request('http://localhost/api/webinars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'AI Masterclass',
          start_time: '2030-01-02T18:00:00.000Z',
          join_link: 'https://example.com/join',
          reminder_rules: [
            {
              id: 'rule-live',
              offset_minutes: 0,
              label: 'At webinar time',
              template_name: 'not_approved',
              enabled: true,
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(webinarQuery.insert).not.toHaveBeenCalled();
  });
});
