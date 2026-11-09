import { describe, expect, it } from 'vitest';
import {
  buildReminderSchedule,
  parseReminderRules,
  type WebinarReminderRule,
} from './reminder-rules';

describe('parseReminderRules', () => {
  it('accepts valid rules and normalizes whitespace', () => {
    expect(
      parseReminderRules([
        {
          id: 'rule-1',
          offset_minutes: -1440,
          label: '  Day before ',
          template_name: ' reminder_24h ',
          enabled: true,
        },
      ])
    ).toEqual([
      {
        id: 'rule-1',
        offset_minutes: -1440,
        label: 'Day before',
        template_name: 'reminder_24h',
        enabled: true,
      },
    ]);
  });

  it.each([
    null,
    {},
    [
      {
        id: 'x',
        offset_minutes: 1.5,
        label: 'x',
        template_name: 't',
        enabled: true,
      },
    ],
    [
      {
        id: 'x',
        offset_minutes: 0,
        label: 'x',
        template_name: 't',
        enabled: true,
      },
      {
        id: 'x',
        offset_minutes: 2,
        label: 'y',
        template_name: 'u',
        enabled: false,
      },
    ],
  ])('rejects invalid rule data %j', (value) => {
    expect(parseReminderRules(value)).toBeNull();
  });
});

describe('buildReminderSchedule', () => {
  it('creates future queue entries only for enabled rules', () => {
    const rules: WebinarReminderRule[] = [
      {
        id: 'before',
        offset_minutes: -60,
        label: '1 hour before',
        template_name: 'one_hour',
        enabled: true,
      },
      {
        id: 'live',
        offset_minutes: 0,
        label: 'Live',
        template_name: 'live',
        enabled: true,
      },
      {
        id: 'disabled',
        offset_minutes: 60,
        label: 'After',
        template_name: 'after',
        enabled: false,
      },
      {
        id: 'past',
        offset_minutes: -120,
        label: 'Earlier',
        template_name: 'earlier',
        enabled: true,
      },
    ];

    expect(
      buildReminderSchedule(
        'webinar-1',
        'registrant-1',
        new Date('2030-01-02T00:00:00.000Z'),
        rules,
        new Date('2030-01-01T23:30:00.000Z')
      )
    ).toEqual([
      {
        webinar_id: 'webinar-1',
        registrant_id: 'registrant-1',
        trigger_type: 'live',
        scheduled_for: '2030-01-02T00:00:00.000Z',
        status: 'pending',
      },
    ]);
  });
});
