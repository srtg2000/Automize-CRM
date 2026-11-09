import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  dispatch: vi.fn(),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => createTestDb(mocks.tables),
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchWebhookToFlow: mocks.dispatch,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({
    success: true,
    remaining: 119,
    reset: 0,
    limit: 120,
  }),
  getClientIp: () => '127.0.0.1',
  rateLimitResponse: () =>
    Response.json({ error: 'rate limited' }, { status: 429 }),
  RATE_LIMITS: { publicApi: { limit: 120, windowMs: 60_000 } },
}));

function createTestDb(tables: Record<string, Array<Record<string, unknown>>>) {
  let sequence = 0;
  return {
    from(table: string) {
      tables[table] ??= [];
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let operation = 'select';
      let values: Record<string, unknown> | Array<Record<string, unknown>> = {};
      let patch: Record<string, unknown> = {};
      const execute = () => {
        const rows = tables[table];
        const matched = rows.filter((row) =>
          filters.every((filter) => filter(row))
        );
        if (operation === 'insert') {
          const created = (Array.isArray(values) ? values : [values]).map(
            (row) => ({
              id: `row-${++sequence}`,
              ...row,
            })
          );
          rows.push(...created);
          return created;
        }
        if (operation === 'update') {
          matched.forEach((row) => Object.assign(row, patch));
          return matched;
        }
        if (operation === 'delete') {
          tables[table] = rows.filter((row) => !matched.includes(row));
          return [];
        }
        return matched;
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => {
          filters.push((row) => row[key] === value);
          return builder;
        },
        in: (key: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[key]));
          return builder;
        },
        ilike: (key: string, value: string) => {
          filters.push(
            (row) =>
              String(row[key] ?? '').toLowerCase() === value.toLowerCase()
          );
          return builder;
        },
        gt: (key: string, value: string) => {
          filters.push((row) => String(row[key]) > value);
          return builder;
        },
        order: () => builder,
        limit: (count: number) => {
          const prior = execute;
          return {
            ...builder,
            maybeSingle: async () => ({
              data: prior().slice(0, count)[0] ?? null,
              error: null,
            }),
            then: (
              resolve: (result: { data: unknown[]; error: null }) => unknown
            ) =>
              Promise.resolve().then(() =>
                resolve({ data: prior().slice(0, count), error: null })
              ),
          };
        },
        update: (next: Record<string, unknown>) => {
          operation = 'update';
          patch = next;
          return builder;
        },
        insert: (
          next: Record<string, unknown> | Array<Record<string, unknown>>
        ) => {
          operation = 'insert';
          values = next;
          return builder;
        },
        upsert: (next: Record<string, unknown>) => {
          operation = 'upsert';
          values = next;
          return builder;
        },
        delete: () => {
          operation = 'delete';
          return builder;
        },
        maybeSingle: async () => ({ data: execute()[0] ?? null, error: null }),
        single: async () => ({ data: execute()[0] ?? null, error: null }),
        then: (
          resolve: (result: { data: unknown[]; error: null }) => unknown
        ) =>
          Promise.resolve().then(() =>
            resolve({ data: execute(), error: null })
          ),
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

import { POST } from './route';

const FLOW_ID = '123e4567-e89b-42d3-a456-426614174000';

function seedFlow() {
  mocks.tables = {
    flows: [
      {
        id: FLOW_ID,
        user_id: 'user-1',
        account_id: 'account-1',
        status: 'active',
        trigger_type: 'webhook',
        trigger_config: {
          field_mappings: {
            phone_header: 'Phone',
            name_header: 'Full name',
            email_header: 'Email',
          },
        },
        entry_node_id: 'start',
      },
    ],
  };
}

function post(payload: unknown) {
  return POST(
    new Request(`https://crm.example/api/automations/webhook/${FLOW_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ flowId: FLOW_ID }) }
  );
}

beforeEach(() => {
  mocks.dispatch
    .mockReset()
    .mockResolvedValue({ consumed: true, outcome: 'started' });
  seedFlow();
});

describe('POST /api/automations/webhook/[flowId]', () => {
  it('rejects invalid JSON shapes before contact ingestion', async () => {
    const response = await post(['not', 'an', 'object']);
    expect(response.status).toBe(400);
    expect(mocks.tables.contacts).toBeUndefined();
  });

  it('requires an international phone number from the mapped sheet column', async () => {
    const response = await post({ Phone: '5551234' });
    expect(response.status).toBe(400);
    expect(mocks.tables.contacts).toBeUndefined();
  });

  it('upserts the mapped contact and dispatches the flow', async () => {
    const response = await post({
      Phone: '+14155550123',
      'Full name': 'Ada Lovelace',
      Email: 'ada@example.test',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, contact_id: 'row-1' });
    expect(mocks.tables.contacts).toContainEqual(
      expect.objectContaining({
        id: 'row-1',
        account_id: 'account-1',
        phone: '14155550123',
        name: 'Ada Lovelace',
        email: 'ada@example.test',
      })
    );
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: FLOW_ID,
        contactId: 'row-1',
        vars: expect.objectContaining({
          name: 'Ada Lovelace',
          phone: '14155550123',
        }),
      })
    );
  });

  it('updates an existing account-scoped contact without clearing omitted fields', async () => {
    mocks.tables.contacts = [
      {
        id: 'existing-contact',
        account_id: 'account-1',
        phone: '14155550123',
        phone_normalized: '14155550123',
        name: 'Old name',
        email: 'keep@example.test',
      },
    ];

    const response = await post({
      Phone: '+14155550123',
      'Full name': 'Ada Lovelace',
    });

    expect(response.status).toBe(200);
    expect(mocks.tables.contacts[0]).toMatchObject({
      id: 'existing-contact',
      name: 'Ada Lovelace',
      email: 'keep@example.test',
    });
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'existing-contact' })
    );
  });

  it('returns 404 for an inactive flow', async () => {
    mocks.tables.flows[0].status = 'draft';
    const response = await post({ Phone: '+14155550123' });
    expect(response.status).toBe(404);
  });

  it('captures test payload headers without creating a CRM contact', async () => {
    const token = '123e4567-e89b-42d3-a456-426614174001';
    mocks.tables.flow_webhook_captures = [
      {
        token,
        flow_id: FLOW_ID,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const response = await POST(
      new Request(
        `https://crm.example/api/automations/webhook/${FLOW_ID}?capture_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            'WhatsApp Number': '+14155550123',
            Name: 'Ada',
          }),
        }
      ),
      { params: Promise.resolve({ flowId: FLOW_ID }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      captured: true,
    });
    expect(mocks.tables.flow_webhook_captures[0]).toMatchObject({
      captured_fields: ['WhatsApp Number', 'Name'],
    });
    expect(mocks.tables.contacts).toBeUndefined();
  });
});
