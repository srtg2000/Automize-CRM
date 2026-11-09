import { NextResponse } from 'next/server';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  assignImportedContactTags,
  resolveImportTagIds,
} from '@/lib/contacts/resolve-import-tags';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { dispatchWebhookToFlow } from '@/lib/flows/engine';
import {
  checkRateLimit,
  getClientIp,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_FIELDS = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FieldMapping {
  phone_header?: string;
  name_header?: string;
  email_header?: string;
  tags_header?: string;
  custom_fields?: Array<{ header?: string; field_name?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mappedValue(
  payload: Record<string, unknown>,
  header: unknown,
  fallback: string
): unknown {
  return typeof header === 'string' && header in payload
    ? payload[header]
    : payload[fallback];
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) {
    const values = value
      .map(scalar)
      .filter((entry): entry is string => entry !== null);
    return values.length ? values.join(', ') : null;
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await context.params;
  if (!UUID_PATTERN.test(flowId)) {
    return NextResponse.json({ error: 'Invalid flow ID.' }, { status: 400 });
  }
  const limit = checkRateLimit(
    `flow-webhook:${flowId}:${getClientIp(request)}`,
    RATE_LIMITS.publicApi
  );
  if (!limit.success) return rateLimitResponse(limit);

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      { error: 'Unable to read request body.' },
      { status: 400 }
    );
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: 'Payload exceeds 64 KB.' },
      { status: 413 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON.' },
      { status: 400 }
    );
  }
  if (!isRecord(payload) || Object.keys(payload).length > MAX_FIELDS) {
    return NextResponse.json(
      {
        error: `Payload must be an object with no more than ${MAX_FIELDS} fields.`,
      },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();
  const captureToken = new URL(request.url).searchParams.get('capture_token');
  if (captureToken) {
    if (!UUID_PATTERN.test(captureToken)) {
      return NextResponse.json(
        { error: 'Invalid capture token.' },
        { status: 400 }
      );
    }
    const { data: capture, error } = await admin
      .from('flow_webhook_captures')
      .select('token')
      .eq('flow_id', flowId)
      .eq('token', captureToken)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) {
      console.error('[flow-webhook] capture lookup failed:', error.message);
      return NextResponse.json(
        { error: 'Unable to capture test payload.' },
        { status: 500 }
      );
    }
    if (!capture) {
      return NextResponse.json(
        { error: 'Capture session was not found or has expired.' },
        { status: 404 }
      );
    }
    const { error: captureError } = await admin
      .from('flow_webhook_captures')
      .update({
        captured_fields: Object.keys(payload),
        captured_payload: payload,
        captured_at: new Date().toISOString(),
      })
      .eq('token', captureToken)
      .eq('flow_id', flowId);
    if (captureError) {
      console.error(
        '[flow-webhook] capture write failed:',
        captureError.message
      );
      return NextResponse.json(
        { error: 'Unable to save captured fields.' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true, captured: true });
  }

  const { data: flow, error: flowError } = await admin
    .from('flows')
    .select(
      'id, user_id, account_id, status, trigger_type, trigger_config, entry_node_id'
    )
    .eq('id', flowId)
    .maybeSingle();
  if (flowError) {
    console.error('[flow-webhook] flow lookup failed:', flowError.message);
    return NextResponse.json(
      { error: 'Unable to load flow.' },
      { status: 500 }
    );
  }
  if (!flow || flow.status !== 'active' || flow.trigger_type !== 'webhook') {
    return NextResponse.json(
      { error: 'Active webhook flow not found.' },
      { status: 404 }
    );
  }

  const config = isRecord(flow.trigger_config) ? flow.trigger_config : {};
  const mappings = isRecord(config.field_mappings)
    ? (config.field_mappings as FieldMapping)
    : {};
  const phone = parseInternationalPhone(
    scalar(mappedValue(payload, mappings.phone_header, 'phone'))
  );
  if (!phone) {
    return NextResponse.json(
      {
        error:
          'A valid international phone number is required in the mapped phone field.',
      },
      { status: 400 }
    );
  }

  try {
    const existing = await findExistingContact(admin, flow.account_id, phone);
    const mappedName = scalar(
      mappedValue(payload, mappings.name_header, 'name')
    );
    const name = mappedName ?? phone;
    const email = scalar(mappedValue(payload, mappings.email_header, 'email'));
    let contactId: string;

    if (existing) {
      const contactPatch: Record<string, unknown> = {
        phone,
        updated_at: new Date().toISOString(),
      };
      if (mappedName) contactPatch.name = mappedName;
      if (email) contactPatch.email = email;
      const { data: updated, error } = await admin
        .from('contacts')
        .update(contactPatch)
        .eq('account_id', flow.account_id)
        .eq('id', existing.id)
        .select('id')
        .single();
      if (error || !updated)
        throw error ?? new Error('Contact update returned no row.');
      contactId = updated.id;
    } else {
      const { data: created, error } = await admin
        .from('contacts')
        .insert({
          account_id: flow.account_id,
          user_id: flow.user_id,
          phone,
          name,
          email,
        })
        .select('id')
        .single();
      if (error || !created) {
        if (!isUniqueViolation(error))
          throw error ?? new Error('Contact insert returned no row.');
        const raced = await findExistingContact(admin, flow.account_id, phone);
        if (!raced)
          throw new Error(
            'Contact could not be resolved after a duplicate insert.'
          );
        contactId = raced.id;
      } else {
        contactId = created.id;
      }
    }

    const configuredCustomFields = Array.isArray(mappings.custom_fields)
      ? mappings.custom_fields
      : [];
    const customValues = configuredCustomFields
      .filter(
        (mapping) =>
          mapping &&
          typeof mapping.header === 'string' &&
          typeof mapping.field_name === 'string' &&
          mapping.field_name.trim()
      )
      .map((mapping) => ({
        fieldName: mapping.field_name!.trim().slice(0, 80),
        value: scalar(payload[mapping.header!]),
      }))
      .filter((mapping) => mapping.value !== null);

    for (const mapping of customValues) {
      const { data: field, error } = await admin
        .from('custom_fields')
        .select('id')
        .eq('account_id', flow.account_id)
        .ilike('field_name', mapping.fieldName)
        .limit(1)
        .maybeSingle();
      if (error) throw error;

      let customFieldId = field?.id as string | undefined;
      if (!customFieldId) {
        const { data: createdField, error: createError } = await admin
          .from('custom_fields')
          .insert({
            account_id: flow.account_id,
            user_id: flow.user_id,
            field_name: mapping.fieldName,
            field_type: 'text',
          })
          .select('id')
          .single();
        if (createError || !createdField)
          throw createError ?? new Error('Custom field creation failed.');
        customFieldId = createdField.id;
      }

      const { error: valueError } = await admin
        .from('contact_custom_values')
        .upsert(
          {
            contact_id: contactId,
            custom_field_id: customFieldId,
            value: mapping.value,
          },
          { onConflict: 'contact_id,custom_field_id' }
        );
      if (valueError) throw valueError;
    }

    const tagValue = scalar(mappedValue(payload, mappings.tags_header, ''));
    const tagNames = tagValue
      ? [
          ...new Set(
            tagValue
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean)
          ),
        ]
          .slice(0, 10)
          .map((tag) => tag.slice(0, 80))
      : [];
    if (tagNames.length > 0) {
      const { tagIdByKey } = await resolveImportTagIds(admin, {
        accountId: flow.account_id,
        userId: flow.user_id,
        tagNames,
        canCreateTags: true,
      });
      await assignImportedContactTags(
        admin,
        [{ contactId, tagNames }],
        tagIdByKey
      );
    }

    const { data: conversations, error: conversationError } = await admin
      .from('conversations')
      .select('id')
      .eq('account_id', flow.account_id)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1);
    if (conversationError) throw conversationError;

    let conversationId = conversations?.[0]?.id as string | undefined;
    if (!conversationId) {
      const { data: conversation, error } = await admin
        .from('conversations')
        .insert({
          account_id: flow.account_id,
          user_id: flow.user_id,
          contact_id: contactId,
        })
        .select('id')
        .single();
      if (error || !conversation) {
        if (!isUniqueViolation(error))
          throw error ?? new Error('Conversation creation failed.');
        const { data: raced, error: raceError } = await admin
          .from('conversations')
          .select('id')
          .eq('account_id', flow.account_id)
          .eq('contact_id', contactId)
          .order('created_at', { ascending: true })
          .limit(1);
        if (raceError || !raced?.[0])
          throw raceError ?? new Error('Conversation could not be resolved.');
        conversationId = raced[0].id;
      } else {
        conversationId = conversation.id;
      }
    }

    const vars = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, scalar(value) ?? ''])
    );
    vars.name = name;
    vars.phone = phone;
    vars.email = email ?? '';

    const result = await dispatchWebhookToFlow({
      flowId,
      contactId,
      conversationId: conversationId ?? null,
      vars,
    });
    if (!result.consumed) {
      return NextResponse.json(
        { error: 'The flow could not be started.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, contact_id: contactId });
  } catch (error) {
    console.error(
      '[flow-webhook] ingestion failed:',
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: 'Unable to process webhook payload.' },
      { status: 500 }
    );
  }
}
