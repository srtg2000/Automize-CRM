import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { registerContactForWebinar } from './register-webinar';

const WEBINAR_ID = 'webinar-1';
const REGISTRANT_ID = 'registrant-1';
const NOW = new Date('2030-01-01T00:00:00.000Z');

function createDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    webinars: [
      {
        id: WEBINAR_ID,
        account_id: 'account-1',
        title: 'CRM Webinar',
        start_time: '2030-01-03T00:00:00.000Z',
        reminder_rules: [
          {
            id: 'one-day',
            offset_minutes: -1440,
            label: 'One day before',
            template_name: 'webinar_reminder',
            enabled: true,
          },
          {
            id: 'disabled',
            offset_minutes: 0,
            label: 'Disabled',
            template_name: 'webinar_live',
            enabled: false,
          },
        ],
      },
    ],
    contacts: [
      {
        id: 'contact-1',
        account_id: 'account-1',
        name: 'Ada Lovelace',
        phone: '14155550123',
      },
    ],
    webinar_registrants: [],
    webinar_campaign_queue: [
      {
        id: 'old-pending',
        webinar_id: WEBINAR_ID,
        registrant_id: REGISTRANT_ID,
        status: 'pending',
      },
      {
        id: 'sent',
        webinar_id: WEBINAR_ID,
        registrant_id: REGISTRANT_ID,
        status: 'sent',
      },
    ],
  };
  let insertedQueue: Record<string, unknown>[] = [];
  let upsertedRegistrant: Record<string, unknown> | null = null;
  const db = {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let operation: 'select' | 'delete' | 'upsert' | 'insert' = 'select';
      let inserted: Record<string, unknown>[] = [];
      let upserted: Record<string, unknown> = {};
      const selectedRows = () =>
        (tables[table] ?? []).filter((row) =>
          filters.every((filter) => filter(row))
        );
      const execute = () => {
        if (operation === 'delete') {
          const removed = selectedRows();
          tables[table] = (tables[table] ?? []).filter(
            (row) => !removed.includes(row)
          );
          return [];
        }
        if (operation === 'upsert') {
          upsertedRegistrant = {
            id: REGISTRANT_ID,
            ...upserted,
          };
          tables[table].push(upsertedRegistrant);
          return [upsertedRegistrant];
        }
        if (operation === 'insert') {
          if (table === 'webinar_campaign_queue') insertedQueue = inserted;
          tables[table].push(...inserted);
          return inserted;
        }
        return selectedRows();
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => {
          filters.push((row) => row[key] === value);
          return builder;
        },
        maybeSingle: async () => ({ data: execute()[0] ?? null, error: null }),
        single: async () => ({ data: execute()[0] ?? null, error: null }),
        upsert: (value: Record<string, unknown>) => {
          operation = 'upsert';
          upserted = value;
          return builder;
        },
        delete: () => {
          operation = 'delete';
          return builder;
        },
        insert: (value: Record<string, unknown>[]) => {
          operation = 'insert';
          inserted = value;
          return builder;
        },
        then: (
          resolve: (result: { data: unknown[]; error: null }) => unknown
        ) =>
          Promise.resolve().then(() =>
            resolve({ data: execute(), error: null })
          ),
      };
      return builder;
    },
  };

  return {
    db: db as unknown as SupabaseClient,
    tables,
    get insertedQueue() {
      return insertedQueue;
    },
    get upsertedRegistrant() {
      return upsertedRegistrant;
    },
  };
}

describe('registerContactForWebinar', () => {
  it('upserts the scoped contact as a registrant and schedules enabled future rules', async () => {
    const fake = createDb();
    const result = await registerContactForWebinar(
      fake.db,
      {
        accountId: 'account-1',
        contactId: 'contact-1',
        webinarId: WEBINAR_ID,
      },
      NOW
    );

    expect(result).toEqual({ registrantId: REGISTRANT_ID, scheduledCount: 1 });
    expect(fake.upsertedRegistrant).toMatchObject({
      webinar_id: WEBINAR_ID,
      account_id: 'account-1',
      phone: '14155550123',
      name: 'Ada Lovelace',
    });
    expect(fake.tables.webinar_campaign_queue).not.toContainEqual(
      expect.objectContaining({ id: 'old-pending' })
    );
    expect(fake.tables.webinar_campaign_queue).toContainEqual(
      expect.objectContaining({ id: 'sent', status: 'sent' })
    );
    expect(fake.insertedQueue).toEqual([
      {
        webinar_id: WEBINAR_ID,
        registrant_id: REGISTRANT_ID,
        trigger_type: 'one-day',
        scheduled_for: '2030-01-02T00:00:00.000Z',
        status: 'pending',
      },
    ]);
  });

  it('rejects a webinar that does not belong to the flow account', async () => {
    const fake = createDb();
    await expect(
      registerContactForWebinar(
        fake.db,
        {
          accountId: 'different-account',
          contactId: 'contact-1',
          webinarId: WEBINAR_ID,
        },
        NOW
      )
    ).rejects.toThrow('Selected webinar was not found');
  });
});
