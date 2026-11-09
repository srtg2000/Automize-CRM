import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin as createAdminClient } from '@/lib/automations/admin-client';
import {
  buildReminderSchedule,
  parseReminderRules,
  type WebinarReminderRule,
} from '@/lib/webinars/reminder-rules';

interface WebinarInput {
  id?: unknown;
  webhook_secret?: unknown;
  title?: unknown;
  start_time?: unknown;
  join_link?: unknown;
  recording_link?: unknown;
  offer_link?: unknown;
  reminder_rules?: unknown;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function validateApprovedTemplates(
  accountId: string,
  rules: WebinarReminderRule[]
) {
  const enabledRules = rules.filter((rule) => rule.enabled);
  const names = [...new Set(enabledRules.map((rule) => rule.template_name))];
  if (names.length === 0) return null;

  const { data: templates, error } = await createAdminClient()
    .from('message_templates')
    .select('name, language')
    .eq('account_id', accountId)
    .eq('status', 'APPROVED')
    .in('name', names);

  if (error) return error.message;
  for (const rule of enabledRules) {
    const approved = (templates ?? []).some(
      (template) =>
        template.name === rule.template_name &&
        (!rule.template_language ||
          template.language === rule.template_language)
    );
    if (!approved) {
      return `WhatsApp template "${rule.template_name}" is not approved for this account`;
    }
  }
  return null;
}

function parseWebinarBody(body: WebinarInput) {
  const id =
    body.id === undefined
      ? undefined
      : typeof body.id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            body.id
          )
        ? body.id
        : null;
  if (id === null) {
    return { error: 'id must be a valid UUID' } as const;
  }

  let webhookSecretHash: string | undefined;
  if (body.webhook_secret !== undefined) {
    if (
      typeof body.webhook_secret !== 'string' ||
      body.webhook_secret.length < 32 ||
      body.webhook_secret.length > 512
    ) {
      return {
        error: 'webhook_secret must be between 32 and 512 characters',
      } as const;
    }
    webhookSecretHash = createHash('sha256')
      .update(body.webhook_secret)
      .digest('hex');
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const startTime =
    typeof body.start_time === 'string' ? new Date(body.start_time) : null;
  if (!title || !startTime || !Number.isFinite(startTime.getTime())) {
    return { error: 'Title and a valid start time are required' } as const;
  }

  const rules = parseReminderRules(body.reminder_rules ?? []);
  if (!rules) {
    return {
      error: 'reminder_rules must contain valid reminder rules',
    } as const;
  }

  const links: Record<
    'join_link' | 'recording_link' | 'offer_link',
    string | null
  > = {
    join_link: null,
    recording_link: null,
    offer_link: null,
  };
  for (const field of Object.keys(links) as (keyof typeof links)[]) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      if (field === 'join_link') {
        return { error: 'A valid join link is required' } as const;
      }
      continue;
    }
    if (typeof value !== 'string' || !isValidHttpUrl(value.trim())) {
      return { error: `${field} must be a valid HTTP(S) URL` } as const;
    }
    links[field] = value.trim();
  }

  return {
    value: {
      id,
      webhookSecretHash,
      title,
      startTime,
      links,
      rules,
    },
  } as const;
}

export async function GET() {
  let context: Awaited<ReturnType<typeof requireRole>>;
  try {
    context = await requireRole('viewer');
  } catch (error) {
    return toErrorResponse(error);
  }

  try {
    const admin = createAdminClient();
    const { data: webinars, error } = await admin
      .from('webinars')
      .select(
        'id, title, start_time, join_link, recording_link, offer_link, reminder_rules'
      )
      .eq('account_id', context.accountId)
      .order('start_time', { ascending: true });

    if (error) {
      console.error('[webinars] list failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const ids = (webinars ?? []).map((webinar) => webinar.id as string);
    if (ids.length === 0) return NextResponse.json({ webinars: [] });

    const [registrantsResult, queueResult] = await Promise.all([
      admin
        .from('webinar_registrants')
        .select('webinar_id')
        .in('webinar_id', ids),
      admin
        .from('webinar_campaign_queue')
        .select('webinar_id, status')
        .in('webinar_id', ids),
    ]);

    const queryError = registrantsResult.error ?? queueResult.error;
    if (queryError) {
      console.error('[webinars] counts failed:', queryError.message);
      return NextResponse.json({ error: queryError.message }, { status: 500 });
    }

    const registeredCounts = new Map<string, number>();
    for (const registrant of registrantsResult.data ?? []) {
      const webinarId = registrant.webinar_id as string;
      registeredCounts.set(
        webinarId,
        (registeredCounts.get(webinarId) ?? 0) + 1
      );
    }

    const sentCounts = new Map<string, number>();
    for (const queueItem of queueResult.data ?? []) {
      if (queueItem.status !== 'sent') continue;
      const webinarId = queueItem.webinar_id as string;
      sentCounts.set(webinarId, (sentCounts.get(webinarId) ?? 0) + 1);
    }

    return NextResponse.json({
      webinars: (webinars ?? []).map((webinar) => ({
        ...webinar,
        registered_count: registeredCounts.get(webinar.id as string) ?? 0,
        messages_sent_count: sentCounts.get(webinar.id as string) ?? 0,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[webinars] list query failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireRole>>;
  try {
    context = await requireRole('agent');
  } catch (error) {
    return toErrorResponse(error);
  }

  const body: WebinarInput | null = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  const parsed = parseWebinarBody(body);
  if (!parsed.value) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const accountId = context.accountId ?? null;
  if (!accountId) {
    return NextResponse.json(
      { error: 'Workspace account is not available' },
      { status: 403 }
    );
  }

  try {
    const templateError = await validateApprovedTemplates(
      accountId,
      parsed.value.rules
    );
    if (templateError) {
      return NextResponse.json({ error: templateError }, { status: 400 });
    }

    const { data: webinar, error } = await createAdminClient()
      .from('webinars')
      .insert({
        ...(parsed.value.id ? { id: parsed.value.id } : {}),
        ...(parsed.value.webhookSecretHash
          ? { webhook_secret_hash: parsed.value.webhookSecretHash }
          : {}),
        account_id: accountId,
        title: parsed.value.title,
        start_time: parsed.value.startTime.toISOString(),
        ...parsed.value.links,
        reminder_rules: parsed.value.rules,
      })
      .select(
        'id, title, start_time, join_link, recording_link, offer_link, reminder_rules'
      )
      .single();

    if (error) {
      console.error('[webinars] create failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!webinar) {
      const message = 'Webinar insert returned no row';
      console.error('[webinars] create failed:', message);
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ webinar }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[webinars] create query failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  let context: Awaited<ReturnType<typeof requireRole>>;
  try {
    context = await requireRole('agent');
  } catch (error) {
    return toErrorResponse(error);
  }

  const body: (WebinarInput & { id?: unknown }) | null = await request
    .json()
    .catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: 'Invalid JSON payload' },
      { status: 400 }
    );
  }
  if (typeof body.id !== 'string' || !body.id.trim()) {
    return NextResponse.json(
      { error: 'Webinar id is required' },
      { status: 400 }
    );
  }

  const parsed = parseWebinarBody({ ...body, id: undefined });
  if (!parsed.value) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const accountId = context.accountId ?? null;
  if (!accountId) {
    return NextResponse.json(
      { error: 'Workspace account is not available' },
      { status: 403 }
    );
  }

  try {
    const admin = createAdminClient();
    const templateError = await validateApprovedTemplates(
      accountId,
      parsed.value.rules
    );
    if (templateError) {
      return NextResponse.json({ error: templateError }, { status: 400 });
    }

    const { data: webinar, error } = await admin
      .from('webinars')
      .update({
        title: parsed.value.title,
        start_time: parsed.value.startTime.toISOString(),
        ...parsed.value.links,
        reminder_rules: parsed.value.rules,
        ...(parsed.value.webhookSecretHash
          ? { webhook_secret_hash: parsed.value.webhookSecretHash }
          : {}),
      })
      .eq('id', body.id.trim())
      .eq('account_id', accountId)
      .select(
        'id, title, start_time, join_link, recording_link, offer_link, reminder_rules'
      )
      .maybeSingle();

    if (error) {
      console.error('[webinars] update failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!webinar) {
      return NextResponse.json({ error: 'Webinar not found' }, { status: 404 });
    }

    const { data: registrants, error: registrantsError } = await admin
      .from('webinar_registrants')
      .select('id')
      .eq('webinar_id', webinar.id);
    if (registrantsError) {
      console.error(
        '[webinars] registrant lookup failed:',
        registrantsError.message
      );
      return NextResponse.json(
        { error: registrantsError.message },
        { status: 500 }
      );
    }

    const { error: deleteError } = await admin
      .from('webinar_campaign_queue')
      .delete()
      .eq('webinar_id', webinar.id)
      .eq('status', 'pending');
    if (deleteError) {
      console.error(
        '[webinars] pending reminder cleanup failed:',
        deleteError.message
      );
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    const now = new Date();
    const startTime = new Date(webinar.start_time);
    const queueEntries = (registrants ?? []).flatMap((registrant) =>
      buildReminderSchedule(
        webinar.id,
        registrant.id,
        startTime,
        parsed.value.rules,
        now
      )
    );
    if (queueEntries.length > 0) {
      const { error: queueError } = await admin
        .from('webinar_campaign_queue')
        .insert(queueEntries);
      if (queueError) {
        console.error(
          '[webinars] reminder reschedule failed:',
          queueError.message
        );
        return NextResponse.json(
          { error: queueError.message },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ webinar });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[webinars] update query failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
