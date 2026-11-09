import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import {
  buildReminderSchedule,
  parseReminderRules,
} from '@/lib/webinars/reminder-rules';

interface SheetsLeadPayload {
  webinar_id?: unknown;
  name?: unknown;
  phone?: unknown;
  custom_data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  let payload: SheetsLeadPayload;
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON payload' },
        { status: 400 }
      );
    }
    payload = body;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  const queryWebinarId = new URL(request.url).searchParams.get('webinar_id');
  if (
    queryWebinarId &&
    payload.webinar_id !== undefined &&
    (typeof payload.webinar_id !== 'string' ||
      payload.webinar_id.trim() !== queryWebinarId.trim())
  ) {
    return NextResponse.json(
      { success: false, error: "'webinar_id' does not match the webhook URL" },
      { status: 400 }
    );
  }
  const webinarIdValue = queryWebinarId ?? payload.webinar_id;
  if (
    typeof webinarIdValue !== 'string' ||
    !webinarIdValue.trim() ||
    typeof payload.phone !== 'string' ||
    !payload.phone.trim()
  ) {
    return NextResponse.json(
      { success: false, error: "'webinar_id' and 'phone' are required" },
      { status: 400 }
    );
  }

  const webinarId = webinarIdValue.trim();

  if (payload.name !== undefined && typeof payload.name !== 'string') {
    return NextResponse.json(
      { success: false, error: "'name' must be a string" },
      { status: 400 }
    );
  }
  if (payload.custom_data !== undefined && !isRecord(payload.custom_data)) {
    return NextResponse.json(
      { success: false, error: "'custom_data' must be an object" },
      { status: 400 }
    );
  }

  const phone = parseInternationalPhone(payload.phone);
  if (!phone) {
    return NextResponse.json(
      {
        success: false,
        error:
          "'phone' must include an international country code (e.g. +14155550123)",
      },
      { status: 400 }
    );
  }

  try {
    const admin = supabaseAdmin();
    const { data: webinar, error: webinarError } = await admin
      .from('webinars')
      .select('start_time, reminder_rules')
      .eq('id', webinarId)
      .maybeSingle();

    if (webinarError) {
      console.error(
        '[sheets-ingest] webinar lookup failed:',
        webinarError.message
      );
      return NextResponse.json(
        { success: false, error: 'Failed to fetch webinar' },
        { status: 500 }
      );
    }
    if (!webinar) {
      return NextResponse.json(
        { success: false, error: 'Webinar not found' },
        { status: 404 }
      );
    }

    const startTime = new Date(webinar.start_time);
    if (!Number.isFinite(startTime.getTime())) {
      console.error('[sheets-ingest] webinar has an invalid start_time');
      return NextResponse.json(
        { success: false, error: 'Webinar start time is invalid' },
        { status: 500 }
      );
    }
    const reminderRules = parseReminderRules(webinar.reminder_rules ?? []);
    if (!reminderRules) {
      console.error('[sheets-ingest] webinar has invalid reminder_rules');
      return NextResponse.json(
        { success: false, error: 'Webinar reminder schedule is invalid' },
        { status: 500 }
      );
    }

    const { data: registrant, error: registrantError } = await admin
      .from('webinar_registrants')
      .upsert(
        {
          webinar_id: webinarId,
          phone,
          name:
            typeof payload.name === 'string'
              ? payload.name.trim() || null
              : null,
          custom_data: payload.custom_data ?? {},
        },
        { onConflict: 'webinar_id,phone' }
      )
      .select('id')
      .single();

    if (registrantError || !registrant) {
      console.error(
        '[sheets-ingest] registrant upsert failed:',
        registrantError?.message
      );
      return NextResponse.json(
        { success: false, error: 'Failed to save registrant' },
        { status: 500 }
      );
    }

    const { error: clearPendingError } = await admin
      .from('webinar_campaign_queue')
      .delete()
      .eq('webinar_id', webinarId)
      .eq('registrant_id', registrant.id)
      .eq('status', 'pending');
    if (clearPendingError) {
      console.error(
        '[sheets-ingest] existing reminder cleanup failed:',
        clearPendingError.message
      );
      return NextResponse.json(
        { success: false, error: 'Failed to refresh reminder schedule' },
        { status: 500 }
      );
    }

    const queueEntries = buildReminderSchedule(
      webinarId,
      registrant.id,
      startTime,
      reminderRules,
      new Date()
    );

    if (queueEntries.length > 0) {
      const { error: queueError } = await admin
        .from('webinar_campaign_queue')
        .insert(queueEntries);

      if (queueError) {
        console.error(
          '[sheets-ingest] campaign queue insert failed:',
          queueError.message
        );
        return NextResponse.json(
          { success: false, error: 'Failed to schedule webinar campaigns' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      registrant_id: registrant.id,
      scheduled_count: queueEntries.length,
    });
  } catch (error) {
    console.error('[sheets-ingest] request failed:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
