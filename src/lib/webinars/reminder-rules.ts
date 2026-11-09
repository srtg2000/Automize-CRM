export interface WebinarReminderRule {
  id: string;
  offset_minutes: number;
  label: string;
  template_name: string;
  template_language?: string;
  enabled: boolean;
}

export function parseReminderRules(
  value: unknown
): WebinarReminderRule[] | null {
  if (!Array.isArray(value)) return null;

  const ids = new Set<string>();
  const rules: WebinarReminderRule[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return null;
    }

    const rule = candidate as Record<string, unknown>;
    if (
      typeof rule.id !== 'string' ||
      !rule.id.trim() ||
      ids.has(rule.id) ||
      typeof rule.offset_minutes !== 'number' ||
      !Number.isSafeInteger(rule.offset_minutes) ||
      typeof rule.label !== 'string' ||
      !rule.label.trim() ||
      typeof rule.template_name !== 'string' ||
      !rule.template_name.trim() ||
      (rule.template_language !== undefined &&
        (typeof rule.template_language !== 'string' ||
          !rule.template_language.trim())) ||
      typeof rule.enabled !== 'boolean'
    ) {
      return null;
    }

    ids.add(rule.id);
    rules.push({
      id: rule.id,
      offset_minutes: rule.offset_minutes,
      label: rule.label.trim(),
      template_name: rule.template_name.trim(),
      ...(typeof rule.template_language === 'string'
        ? { template_language: rule.template_language.trim() }
        : {}),
      enabled: rule.enabled,
    });
  }

  return rules;
}

export function buildReminderSchedule(
  webinarId: string,
  registrantId: string,
  startTime: Date,
  rules: WebinarReminderRule[],
  now: Date
) {
  return rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      webinar_id: webinarId,
      registrant_id: registrantId,
      trigger_type: rule.id,
      scheduled_for: new Date(
        startTime.getTime() + rule.offset_minutes * 60_000
      ),
      status: 'pending' as const,
    }))
    .filter((entry) => entry.scheduled_for.getTime() > now.getTime())
    .map((entry) => ({
      ...entry,
      scheduled_for: entry.scheduled_for.toISOString(),
    }));
}
