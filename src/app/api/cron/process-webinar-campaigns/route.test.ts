import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseAdmin = vi.fn();
const decrypt = vi.fn((token: string) => `decrypted-${token}`);
const sendTemplateMessage = vi.fn();
const resolveTemplateRow = vi.fn();

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => supabaseAdmin(),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (token: string) => decrypt(token),
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: (...args: unknown[]) => resolveTemplateRow(...args),
}));

import { GET, POST } from './route';

function createAdmin(
  items: Array<{
    id: string;
    trigger_type: string;
    registrant: {
      name: string | null;
      phone: string;
      webinar_id: string;
      custom_data?: Record<string, unknown> | null;
    }[];
    webinar: {
      title: string;
      start_time: string;
      join_link: string | null;
      recording_link: string | null;
      offer_link: string | null;
      account_id: string;
      reminder_rules: unknown;
    }[];
  }>
) {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  const queueQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: items, error: null }),
    update: vi.fn((values: Record<string, unknown>) => ({
      eq: vi.fn(async (_column: string, id: string) => {
        updates.push({ id, values });
        return { error: null };
      }),
    })),
  };
  const configQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        phone_number_id: 'phone-id',
        access_token: 'encrypted-token',
        status: 'connected',
      },
      error: null,
    }),
  };
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'webinar_campaign_queue') return queueQuery;
      if (table === 'whatsapp_config') return configQuery;
      if (table === 'message_templates') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
  return { admin, updates };
}

function campaignItem(
  id: string,
  trigger_type: string,
  rule: { id: string; offset_minutes: number; template_name: string }
) {
  return {
    id,
    trigger_type,
    registrant: [
      { name: 'Jane Doe', phone: '14155550123', webinar_id: 'webinar-1' },
    ],
    webinar: [
      {
        title: 'Product webinar',
        start_time: '2030-01-02T18:00:00.000Z',
        join_link: 'https://example.com/join',
        recording_link: 'https://example.com/recording',
        offer_link: 'https://example.com/offer',
        account_id: 'account-1',
        reminder_rules: [
          {
            ...rule,
            label: rule.id,
            template_language: 'en_US',
            enabled: true,
          },
        ],
      },
    ],
  };
}

function request(
  method: 'GET' | 'POST',
  authorization = 'Bearer cron-test-secret'
) {
  return new Request('http://localhost/api/cron/process-webinar-campaigns', {
    method,
    headers: { authorization },
  });
}

describe('/api/cron/process-webinar-campaigns', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-test-secret';
    resolveTemplateRow.mockResolvedValue({
      malformed: false,
      language: 'en_US',
      row: { body_text: '{{1}} {{2}} {{3}}' },
    });
    sendTemplateMessage.mockResolvedValue({ messageId: 'message-id' });
  });

  it('accepts GET and POST but rejects an invalid secret', async () => {
    const unauthorized = await GET(request('GET', 'Bearer wrong-secret'));
    expect(unauthorized.status).toBe(401);
    expect(supabaseAdmin).not.toHaveBeenCalled();

    const { admin } = createAdmin([]);
    supabaseAdmin.mockReturnValue(admin);
    const getResponse = await GET(request('GET'));
    const postResponse = await POST(request('POST'));

    expect(getResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      processed: 0,
      successful: 0,
      failed: 0,
    });
  });

  it('sends each trigger template with its expected parameters and marks the queue sent', async () => {
    const items = [
      campaignItem('queue-24h', 'rule-24h', {
        id: 'rule-24h',
        offset_minutes: -1440,
        template_name: 'custom_24h',
      }),
      campaignItem('queue-1h', 'rule-1h', {
        id: 'rule-1h',
        offset_minutes: -60,
        template_name: 'custom_1h',
      }),
      campaignItem('queue-live', 'rule-live', {
        id: 'rule-live',
        offset_minutes: 0,
        template_name: 'custom_live',
      }),
      campaignItem('queue-post', 'rule-post', {
        id: 'rule-post',
        offset_minutes: 120,
        template_name: 'custom_post',
      }),
    ];
    const { admin, updates } = createAdmin(items);
    supabaseAdmin.mockReturnValue(admin);

    const response = await GET(request('GET'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      processed: 4,
      successful: 4,
      failed: 0,
    });
    expect(sendTemplateMessage.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({
        templateName: 'custom_24h',
        params: [
          'Jane Doe',
          'Product webinar',
          'January 2, 2030 at 6:00 PM UTC',
        ],
      }),
      expect.objectContaining({
        templateName: 'custom_1h',
        params: [
          'Jane Doe',
          'Product webinar',
          'January 2, 2030 at 6:00 PM UTC',
        ],
      }),
      expect.objectContaining({
        templateName: 'custom_live',
        params: ['Jane Doe', 'Product webinar', 'https://example.com/join'],
      }),
      expect.objectContaining({
        templateName: 'custom_post',
        params: [
          'Jane Doe',
          'Product webinar',
          'https://example.com/recording',
        ],
      }),
    ]);
    expect(updates).toHaveLength(4);
    expect(updates[0].values).toMatchObject({ status: 'sent' });
    expect(updates[0].values.sent_at).toEqual(expect.any(String));
  });

  it('stores the send error on the queue item and reports it as failed', async () => {
    const { admin, updates } = createAdmin([
      campaignItem('queue-failed', 'live-rule', {
        id: 'live-rule',
        offset_minutes: 0,
        template_name: 'custom_live',
      }),
    ]);
    supabaseAdmin.mockReturnValue(admin);
    sendTemplateMessage.mockRejectedValueOnce(
      new Error('Meta rejected template')
    );

    const response = await POST(request('POST'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      processed: 1,
      successful: 0,
      failed: 1,
    });
    expect(updates).toEqual([
      {
        id: 'queue-failed',
        values: { status: 'failed', error_message: 'Meta rejected template' },
      },
    ]);
  });
});
