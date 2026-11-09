import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildReminderSchedule,
  parseReminderRules,
} from '@/lib/webinars/reminder-rules';

export async function registerContactForWebinar(
  db: SupabaseClient,
  input: {
    accountId: string;
    contactId: string;
    webinarId: string;
  },
  now = new Date()
): Promise<{ registrantId: string; scheduledCount: number }> {
  const { data: webinar, error: webinarError } = await db
    .from('webinars')
    .select('id, title, start_time, reminder_rules')
    .eq('id', input.webinarId)
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (webinarError) throw webinarError;
  if (!webinar) throw new Error('Selected webinar was not found.');

  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('name, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (contactError) throw contactError;
  if (!contact?.phone) {
    throw new Error(
      'Contact phone number is required to register for a webinar.'
    );
  }

  const startTime = new Date(webinar.start_time);
  if (!Number.isFinite(startTime.getTime())) {
    throw new Error('Webinar start time is invalid.');
  }
  const reminderRules = parseReminderRules(webinar.reminder_rules ?? []);
  if (!reminderRules) {
    throw new Error('Webinar reminder rules are invalid.');
  }

  const { data: registrant, error: registrantError } = await db
    .from('webinar_registrants')
    .upsert(
      {
        webinar_id: webinar.id,
        account_id: input.accountId,
        phone: contact.phone,
        name: contact.name ?? null,
      },
      { onConflict: 'webinar_id,phone' }
    )
    .select('id')
    .single();
  if (registrantError || !registrant) {
    throw registrantError ?? new Error('Webinar registration returned no row.');
  }

  const { error: clearPendingError } = await db
    .from('webinar_campaign_queue')
    .delete()
    .eq('webinar_id', webinar.id)
    .eq('registrant_id', registrant.id)
    .eq('status', 'pending');
  if (clearPendingError) throw clearPendingError;

  const queueEntries = buildReminderSchedule(
    webinar.id,
    registrant.id,
    startTime,
    reminderRules,
    now
  );
  if (queueEntries.length > 0) {
    const { error: queueError } = await db
      .from('webinar_campaign_queue')
      .insert(queueEntries);
    if (queueError) throw queueError;
  }

  return {
    registrantId: registrant.id,
    scheduledCount: queueEntries.length,
  };
}
