import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  parseReminderRules,
  type WebinarReminderRule,
} from '@/lib/webinars/reminder-rules';

const BATCH_SIZE = 20;
interface CampaignQueueItem {
  id: string;
  trigger_type: string;
  registrant: {
    name: string | null;
    phone: string;
    webinar_id: string;
    custom_data?: Record<string, unknown> | null;
  } | null;
  webinar: {
    title: string;
    start_time: string;
    join_link: string | null;
    recording_link: string | null;
    offer_link: string | null;
    account_id: string;
    reminder_rules: unknown;
  } | null;
}

function formatWebinarDate(startTime: string | undefined): string {
  if (!startTime) return '';
  const date = new Date(startTime);
  if (!Number.isFinite(date.getTime())) return '';
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)} UTC`;
}

function paramValueForKey(
  key: string,
  item: CampaignQueueItem,
  rule: WebinarReminderRule
): string {
  const webinar = item.webinar;
  const registrant = item.registrant;
  if (!webinar || !registrant) return '';

  const aliases: Record<string, string> = {
    name: registrant.name ?? '',
    first_name: registrant.name?.trim().split(/\s+/)[0] ?? '',
    customer_name: registrant.name ?? '',
    registrant_name: registrant.name ?? '',
    title: webinar.title,
    webinar_title: webinar.title,
    date: formatWebinarDate(webinar.start_time),
    webinar_date: formatWebinarDate(webinar.start_time),
    start_time: formatWebinarDate(webinar.start_time),
    join_link: webinar.join_link ?? '',
    meeting_link: webinar.join_link ?? '',
    recording_link: webinar.recording_link ?? '',
    offer_link: webinar.offer_link ?? '',
    checkout_link: webinar.offer_link ?? '',
  };
  const customValue = registrant.custom_data?.[key];
  if (typeof customValue === 'string' || typeof customValue === 'number') {
    return String(customValue);
  }
  if (Object.hasOwn(aliases, key.toLowerCase()))
    return aliases[key.toLowerCase()];

  const positionalValues =
    rule.offset_minutes > 0
      ? [
          registrant.name ?? '',
          webinar.title,
          webinar.recording_link ?? '',
          webinar.offer_link ?? '',
          webinar.join_link ?? '',
          formatWebinarDate(webinar.start_time),
        ]
      : [
          registrant.name ?? '',
          webinar.title,
          ...(rule.offset_minutes === 0
            ? [webinar.join_link ?? '', formatWebinarDate(webinar.start_time)]
            : [formatWebinarDate(webinar.start_time), webinar.join_link ?? '']),
          webinar.recording_link ?? '',
          webinar.offer_link ?? '',
        ];
  const index = Number(key) - 1;
  return Number.isInteger(index) && index >= 0
    ? (positionalValues[index] ?? '')
    : '';
}

function templateParamsForRule(
  bodyText: string,
  item: CampaignQueueItem,
  rule: WebinarReminderRule
): string[] {
  const keys = new Set(
    [...bodyText.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((match) => match[1])
  );
  const variables = [...keys].every((key) => /^\d+$/.test(key))
    ? [...keys].sort((a, b) => Number(a) - Number(b))
    : [...keys].sort((a, b) => a.localeCompare(b));
  return variables.map((key) => paramValueForKey(key, item, rule));
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer ?? request.headers.get('x-cron-secret') ?? '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);

  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

async function processCampaigns(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = supabaseAdmin();
    const { data: dueItems, error: fetchError } = await admin
      .from('webinar_campaign_queue')
      .select(
        'id, trigger_type, registrant:webinar_registrants(name, phone, webinar_id, custom_data), webinar:webinars(title, start_time, join_link, recording_link, offer_link, account_id, reminder_rules)'
      )
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error(
        '[webinar-campaign-cron] queue fetch failed:',
        fetchError.message
      );
      return NextResponse.json(
        { error: 'Failed to fetch campaign queue' },
        { status: 500 }
      );
    }

    let successful = 0;
    let failed = 0;

    for (const rawItem of dueItems ?? []) {
      const item: CampaignQueueItem = {
        id: rawItem.id,
        trigger_type: rawItem.trigger_type,
        registrant: Array.isArray(rawItem.registrant)
          ? (rawItem.registrant[0] ?? null)
          : (rawItem.registrant ?? null),
        webinar: Array.isArray(rawItem.webinar)
          ? (rawItem.webinar[0] ?? null)
          : (rawItem.webinar ?? null),
      };
      let errorMessage: string | null = null;
      let sent = false;

      try {
        if (!item.registrant || !item.webinar) {
          throw new Error('Queue item is missing its registrant or webinar');
        }
        if (!item.webinar.account_id) {
          throw new Error('Webinar has no associated account');
        }

        const phone = normalizePhone(item.registrant.phone);
        if (!isValidE164(phone)) {
          throw new Error(
            'Registrant phone is not a valid international number'
          );
        }

        const { data: config, error: configError } = await admin
          .from('whatsapp_config')
          .select('phone_number_id, access_token, status')
          .eq('account_id', item.webinar.account_id)
          .maybeSingle();

        if (configError)
          throw new Error(
            `WhatsApp config lookup failed: ${configError.message}`
          );
        if (
          !config ||
          config.status !== 'connected' ||
          !config.phone_number_id
        ) {
          throw new Error('WhatsApp is not configured for the webinar account');
        }

        const rules = parseReminderRules(item.webinar.reminder_rules ?? []);
        if (!rules) throw new Error('Webinar reminder schedule is invalid');
        const rule = rules.find(
          (candidate) => candidate.id === item.trigger_type && candidate.enabled
        );
        if (!rule) {
          throw new Error(
            `Reminder rule "${item.trigger_type}" is missing or disabled`
          );
        }

        const resolvedTemplate = await resolveTemplateRow(
          admin,
          item.webinar.account_id,
          rule.template_name,
          rule.template_language
        );
        if (resolvedTemplate.malformed) {
          throw new Error(
            `WhatsApp template "${rule.template_name}" is malformed`
          );
        }
        if (!resolvedTemplate.row) {
          throw new Error(
            `WhatsApp template "${rule.template_name}" is not available`
          );
        }

        await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken: decrypt(config.access_token),
          to: phone,
          templateName: rule.template_name,
          language: resolvedTemplate.language,
          template: resolvedTemplate.row,
          params: templateParamsForRule(
            resolvedTemplate.row.body_text,
            item,
            rule
          ),
        });
        sent = true;
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `[webinar-campaign-cron] failed queue item ${item.id}:`,
          errorMessage
        );
      }

      const { error: updateError } = await admin
        .from('webinar_campaign_queue')
        .update(
          sent
            ? {
                status: 'sent',
                sent_at: new Date().toISOString(),
                error_message: null,
              }
            : { status: 'failed', error_message: errorMessage }
        )
        .eq('id', item.id);

      if (updateError) {
        console.error(
          `[webinar-campaign-cron] failed to update queue item ${item.id}:`,
          updateError.message
        );
        failed += 1;
      } else if (sent) {
        successful += 1;
      } else {
        failed += 1;
      }
    }

    return NextResponse.json({
      processed: successful + failed,
      successful,
      failed,
    });
  } catch (error) {
    console.error('[webinar-campaign-cron] processing failed:', error);
    return NextResponse.json(
      { error: 'Failed to process webinar campaigns' },
      { status: 500 }
    );
  }
}

export const GET = processCampaigns;
export const POST = processCampaigns;
