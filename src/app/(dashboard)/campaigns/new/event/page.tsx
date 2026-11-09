'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Loader2,
  Plus,
  Trash2,
  Users,
  Webhook,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createClient } from '@/lib/supabase/client';
import type { WebinarReminderRule } from '@/lib/webinars/reminder-rules';

type AudienceSource = 'webhook' | 'crm' | 'csv';

interface TemplateOption {
  id: string;
  name: string;
  language: string | null;
  category: string;
}

type ReminderDraft = WebinarReminderRule;

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

interface TagOption {
  id: string;
  name: string;
}

const STEPS = ['Event', 'Audience', 'Reminders', 'Review'] as const;

const OFFSET_PRESETS = [
  { value: -1440, label: '24 hours before' },
  { value: -60, label: '1 hour before' },
  { value: 0, label: 'At event time' },
  { value: 120, label: '2 hours after' },
];

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvRow(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ''])
    );
  });
}

function reminderLabel(offset: number): string {
  if (offset === 0) return 'At event time';
  const absolute = Math.abs(offset);
  const unit =
    absolute % 1440 === 0 ? 'day' : absolute % 60 === 0 ? 'hour' : 'minute';
  const amount =
    unit === 'day'
      ? absolute / 1440
      : unit === 'hour'
        ? absolute / 60
        : absolute;
  return `${amount} ${unit}${amount === 1 ? '' : 's'} ${offset < 0 ? 'before' : 'after'}`;
}

function eventDateTime(date: string, time: string): string {
  return new Date(`${date}T${time}:00+05:30`).toISOString();
}

export default function NewEventCampaignPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [campaignId, setCampaignId] = useState('');
  const [origin, setOrigin] = useState('');
  const [created, setCreated] = useState(false);
  const [registeredCount, setRegisteredCount] = useState(0);
  const [registrationFailures, setRegistrationFailures] = useState(0);
  const [form, setForm] = useState({
    title: '',
    date: '',
    time: '',
    joinLink: '',
    recordingLink: '',
    offerLink: '',
  });
  const [audience, setAudience] = useState<AudienceSource>('webhook');
  const [nameColumn, setNameColumn] = useState('Name');
  const [phoneColumn, setPhoneColumn] = useState('Phone');
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<ReminderDraft[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [contactTagIds, setContactTagIds] = useState<
    { contact_id: string; tag_id: string }[]
  >([]);
  const [selectedTag, setSelectedTag] = useState('__all__');
  const [contactsLoading, setContactsLoading] = useState(false);

  useEffect(() => {
    setCampaignId(crypto.randomUUID());
    setOrigin(window.location.origin);
    let active = true;
    void fetch('/api/whatsapp/templates')
      .then(async (response) => {
        const result = (await response.json()) as {
          templates?: TemplateOption[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(result.error ?? 'Could not load approved templates');
        }
        if (active) setTemplates(result.templates ?? []);
      })
      .catch((error: unknown) => {
        if (active) {
          setTemplateError(
            error instanceof Error ? error.message : 'Could not load templates'
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const webhookUrl = useMemo(
    () =>
      campaignId
        ? `${origin}/api/webhooks/sheets-ingest?webinar_id=${encodeURIComponent(campaignId)}`
        : '',
    [campaignId, origin]
  );
  const scriptSnippet = useMemo(
    () => `const WEBHOOK_URL = '${webhookUrl}';
const NAME_COLUMN = '${nameColumn}';
const PHONE_COLUMN = '${phoneColumn}';

function onFormSubmit(e) {
  const answers = e.namedValues || {};
  const custom_data = {};
  Object.keys(answers).forEach((key) => {
    custom_data[key] = (answers[key] || [''])[0];
  });
  const response = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      name: (answers[NAME_COLUMN] || [''])[0],
      phone: (answers[PHONE_COLUMN] || [''])[0],
      custom_data
    }),
    muteHttpExceptions: true
  });
  console.log(response.getResponseCode(), response.getContentText());
}`,
    [nameColumn, phoneColumn, webhookUrl]
  );
  const csvColumns = csvHeaders.length ? csvHeaders : ['Name', 'Phone'];
  const eligibleContacts = useMemo(() => {
    if (selectedTag === '__all__') return contacts;
    const matchingIds = new Set(
      contactTagIds
        .filter((link) => link.tag_id === selectedTag)
        .map((link) => link.contact_id)
    );
    return contacts.filter((contact) => matchingIds.has(contact.id));
  }, [contactTagIds, contacts, selectedTag]);

  async function loadCrmAudience() {
    if (contacts.length || contactsLoading) return;
    setContactsLoading(true);
    try {
      const supabase = createClient();
      const [contactsResult, tagsResult, linksResult] = await Promise.all([
        supabase.from('contacts').select('id, name, phone').limit(1000),
        supabase.from('tags').select('id, name').order('name'),
        supabase.from('contact_tags').select('contact_id, tag_id'),
      ]);
      const error =
        contactsResult.error ?? tagsResult.error ?? linksResult.error;
      if (error) throw error;
      setContacts(
        (contactsResult.data ?? []).filter(
          (contact) => typeof contact.phone === 'string' && contact.phone
        ) as ContactOption[]
      );
      setTags((tagsResult.data ?? []) as TagOption[]);
      setContactTagIds(
        (linksResult.data ?? []) as { contact_id: string; tag_id: string }[]
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not load CRM contacts'
      );
    } finally {
      setContactsLoading(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard!');
    } catch {
      toast.error('Clipboard access failed. Please copy the text manually.');
    }
  }

  function addReminder(offset = -1440) {
    const template = templates[0];
    if (!template) {
      toast.error(
        'Add an approved WhatsApp template before creating reminders.'
      );
      return;
    }
    setReminders((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        offset_minutes: offset,
        label: reminderLabel(offset),
        template_name: template.name,
        template_language: template.language ?? 'en_US',
        enabled: true,
      },
    ]);
  }

  function updateReminder(id: string, patch: Partial<ReminderDraft>) {
    setReminders((current) =>
      current.map((rule) => {
        if (rule.id !== id) return rule;
        const next = { ...rule, ...patch };
        if (patch.offset_minutes !== undefined) {
          next.label = reminderLabel(next.offset_minutes);
        }
        return next;
      })
    );
  }

  function validCurrentStep() {
    if (step === 0) {
      if (!form.title.trim() || !form.date || !form.time || !form.joinLink) {
        toast.error('Complete the event name, date, time, and join link.');
        return false;
      }
      const startsAt = new Date(eventDateTime(form.date, form.time));
      if (startsAt.getTime() <= Date.now()) {
        toast.error('Choose an event time in the future.');
        return false;
      }
    }
    if (step === 1 && audience === 'csv' && csvRows.length === 0) {
      toast.error('Upload a CSV with at least one contact.');
      return false;
    }
    if (step === 2 && reminders.some((rule) => !rule.template_name)) {
      toast.error('Choose an approved template for every reminder.');
      return false;
    }
    return true;
  }

  async function launchCampaign() {
    if (!validCurrentStep()) return;
    setSaving(true);
    try {
      const startTime = eventDateTime(form.date, form.time);
      const response = await fetch('/api/webinars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: campaignId,
          title: form.title.trim(),
          start_time: startTime,
          join_link: form.joinLink.trim(),
          recording_link: form.recordingLink.trim() || null,
          offer_link: form.offerLink.trim() || null,
          reminder_rules: reminders,
        }),
      });
      const result = (await response.json()) as {
        webinar?: { id: string };
        error?: string;
      };
      if (!response.ok || !result.webinar) {
        throw new Error(result.error ?? 'Could not launch event campaign');
      }

      const leads =
        audience === 'crm'
          ? eligibleContacts.map((contact) => ({
              name: contact.name ?? '',
              phone: contact.phone,
            }))
          : audience === 'csv'
            ? csvRows.map((row) => ({
                name: row[nameColumn] ?? '',
                phone: row[phoneColumn] ?? '',
                custom_data: row,
              }))
            : [];
      let successCount = 0;
      let failedCount = 0;
      if (leads.length) {
        for (let offset = 0; offset < leads.length; offset += 10) {
          const batchResults = await Promise.allSettled(
            leads.slice(offset, offset + 10).map(async (lead) => {
              const ingestResponse = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(lead),
              });
              if (!ingestResponse.ok) {
                const ingestResult = (await ingestResponse.json()) as {
                  error?: string;
                };
                throw new Error(
                  ingestResult.error ?? 'Could not register an audience contact'
                );
              }
              return true;
            })
          );
          for (const batchResult of batchResults) {
            if (batchResult.status === 'fulfilled') successCount += 1;
            else failedCount += 1;
          }
        }
      }
      setRegisteredCount(successCount);
      setRegistrationFailures(failedCount);
      setCreated(true);
      if (failedCount) {
        toast.warning(
          `Campaign launched; ${successCount} contacts registered and ${failedCount} could not be registered.`
        );
      } else {
        toast.success('Event campaign launched');
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not launch campaign'
      );
    } finally {
      setSaving(false);
    }
  }

  if (created) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <section className="border-border bg-card rounded-2xl border p-6 text-center sm:p-10">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
            <CheckCircle2 className="size-7" />
          </span>
          <h1 className="text-foreground mt-5 text-2xl font-semibold">
            Your event campaign is ready
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {registrationFailures > 0
              ? `${registeredCount} contacts were registered and their future reminders are scheduled. ${registrationFailures} contacts could not be registered; review their international phone numbers and retry.`
              : registeredCount > 0
                ? `${registeredCount} contacts were registered and their future reminders are scheduled.`
                : 'Your reminder schedule is saved. Share the webhook to start registering attendees.'}
          </p>
          <div className="border-border bg-muted/40 mt-7 rounded-xl border p-4 text-left">
            <p className="text-muted-foreground mb-2 text-xs font-medium">
              Registration webhook
            </p>
            <div className="flex items-center gap-2">
              <code className="bg-background min-w-0 flex-1 truncate rounded-lg border px-3 py-2 text-xs">
                {webhookUrl}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copy(webhookUrl)}
              >
                <Copy data-icon="inline-start" />
                Copy
              </Button>
            </div>
          </div>
          <div className="mt-6 flex justify-center gap-3">
            <Button variant="outline" onClick={() => router.push('/campaigns')}>
              Campaigns
            </Button>
            <Button
              className="bg-orange-500 text-white hover:bg-orange-600"
              onClick={() => router.push('/campaigns')}
            >
              Done
            </Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Back to campaigns"
          onClick={() => router.push('/campaigns')}
        >
          <ArrowLeft />
        </Button>
        <div>
          <p className="text-xs font-semibold tracking-widest text-orange-400 uppercase">
            New event campaign
          </p>
          <h1 className="text-foreground mt-1 text-2xl font-semibold">
            Build your event journey
          </h1>
        </div>
      </header>

      <nav aria-label="Campaign setup steps" className="flex items-center">
        {STEPS.map((label, index) => (
          <div key={label} className="flex min-w-0 flex-1 items-center">
            <button
              type="button"
              onClick={() => index < step && setStep(index)}
              disabled={index > step}
              className="flex items-center gap-2 disabled:cursor-default"
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                  index < step
                    ? 'border-orange-500 bg-orange-500 text-white'
                    : index === step
                      ? 'border-orange-400 bg-orange-500/10 text-orange-300'
                      : 'border-border text-muted-foreground'
                }`}
              >
                {index < step ? <Check className="size-4" /> : index + 1}
              </span>
              <span
                className={`hidden text-xs font-medium sm:block ${
                  index === step ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {label}
              </span>
            </button>
            {index < STEPS.length - 1 && (
              <span
                className={`mx-2 h-px flex-1 ${
                  index < step ? 'bg-orange-500' : 'bg-border'
                }`}
              />
            )}
          </div>
        ))}
      </nav>

      <section className="border-border bg-card rounded-2xl border p-5 sm:p-7">
        {step === 0 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-foreground text-lg font-semibold">
                Event details
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Start with the details attendees will receive.
              </p>
            </div>
            <label className="block space-y-1.5 text-sm font-medium">
              Event name
              <Input
                value={form.title}
                onChange={(event) =>
                  setForm({ ...form, title: event.target.value })
                }
                placeholder="AI Masterclass"
                required
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm font-medium">
                Event date
                <Input
                  type="date"
                  value={form.date}
                  onChange={(event) =>
                    setForm({ ...form, date: event.target.value })
                  }
                  required
                />
              </label>
              <label className="block space-y-1.5 text-sm font-medium">
                Event time{' '}
                <span className="text-orange-400">IST · UTC+05:30</span>
                <Input
                  type="time"
                  value={form.time}
                  onChange={(event) =>
                    setForm({ ...form, time: event.target.value })
                  }
                  required
                />
              </label>
            </div>
            <label className="block space-y-1.5 text-sm font-medium">
              Location / Zoom join link
              <Input
                type="url"
                value={form.joinLink}
                onChange={(event) =>
                  setForm({ ...form, joinLink: event.target.value })
                }
                placeholder="https://zoom.us/j/..."
                required
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm font-medium">
                Recording link{' '}
                <span className="text-muted-foreground">(optional)</span>
                <Input
                  type="url"
                  value={form.recordingLink}
                  onChange={(event) =>
                    setForm({ ...form, recordingLink: event.target.value })
                  }
                  placeholder="https://..."
                />
              </label>
              <label className="block space-y-1.5 text-sm font-medium">
                Offer link{' '}
                <span className="text-muted-foreground">(optional)</span>
                <Input
                  type="url"
                  value={form.offerLink}
                  onChange={(event) =>
                    setForm({ ...form, offerLink: event.target.value })
                  }
                  placeholder="https://..."
                />
              </label>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-foreground text-lg font-semibold">
                Choose your audience source
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Attendees are registered to this event and eligible reminders
                are queued.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                {
                  id: 'webhook' as const,
                  title: 'Google Sheets / Forms',
                  icon: Webhook,
                },
                {
                  id: 'crm' as const,
                  title: 'CRM contacts / tags',
                  icon: Users,
                },
                { id: 'csv' as const, title: 'CSV import', icon: CalendarDays },
              ].map((source) => {
                const Icon = source.icon;
                const selected = audience === source.id;
                return (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => {
                      setAudience(source.id);
                      if (source.id === 'crm') void loadCrmAudience();
                    }}
                    className={`rounded-xl border p-4 text-left transition ${
                      selected
                        ? 'border-orange-500/50 bg-orange-500/5 ring-1 ring-orange-500/30'
                        : 'border-border hover:bg-muted/30'
                    }`}
                  >
                    <Icon
                      className={
                        selected
                          ? 'size-5 text-orange-400'
                          : 'text-muted-foreground size-5'
                      }
                    />
                    <span className="text-foreground mt-3 block text-sm font-medium">
                      {source.title}
                    </span>
                  </button>
                );
              })}
            </div>
            {audience === 'webhook' && (
              <div className="border-border bg-muted/20 space-y-4 rounded-xl border p-4">
                <div>
                  <p className="text-foreground text-sm font-medium">
                    Registration webhook
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    This unique URL becomes active as soon as you launch the
                    campaign.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <code className="bg-background min-w-0 flex-1 truncate rounded-lg border px-3 py-2.5 font-mono text-xs">
                    {webhookUrl || 'Preparing secure event URL…'}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!webhookUrl}
                    onClick={() => void copy(webhookUrl)}
                  >
                    <Copy data-icon="inline-start" />
                    Copy
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-xs font-medium">
                    Name column
                    <Input
                      value={nameColumn}
                      onChange={(event) => setNameColumn(event.target.value)}
                    />
                  </label>
                  <label className="space-y-1 text-xs font-medium">
                    Phone / WhatsApp column
                    <Input
                      value={phoneColumn}
                      onChange={(event) => setPhoneColumn(event.target.value)}
                    />
                  </label>
                </div>
                <div className="overflow-hidden rounded-lg border">
                  <div className="bg-muted/40 flex items-center justify-between px-3 py-2">
                    <span className="text-xs font-medium">
                      Google Apps Script
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void copy(scriptSnippet)}
                    >
                      <Copy data-icon="inline-start" />
                      Copy code
                    </Button>
                  </div>
                  <pre className="max-h-52 overflow-auto bg-neutral-950 p-3 text-xs text-neutral-200">
                    <code>{scriptSnippet}</code>
                  </pre>
                </div>
              </div>
            )}
            {audience === 'crm' && (
              <div className="border-border bg-muted/20 rounded-xl border p-4">
                <label className="block space-y-2 text-sm font-medium">
                  Register contacts
                  <select
                    value={selectedTag}
                    onChange={(event) => setSelectedTag(event.target.value)}
                    disabled={contactsLoading}
                    className="border-input bg-background h-10 w-full rounded-lg border px-3 text-sm"
                  >
                    <option value="__all__">
                      All CRM contacts with a phone number
                    </option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        Tag: {tag.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-muted-foreground mt-2 text-xs">
                  {contactsLoading
                    ? 'Loading your workspace contacts…'
                    : `${eligibleContacts.length} contacts will be registered (up to 1,000 loaded).`}
                </p>
              </div>
            )}
            {audience === 'csv' && (
              <div className="border-border bg-muted/20 rounded-xl border p-4">
                <label className="block space-y-2 text-sm font-medium">
                  Upload CSV
                  <Input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const rows = parseCsv(await file.text());
                      const headers = Object.keys(rows[0] ?? {});
                      setCsvRows(rows);
                      setCsvHeaders(headers);
                      if (headers.length) {
                        const nameHeader = headers.find((header) =>
                          /name/i.test(header)
                        );
                        const phoneHeader = headers.find((header) =>
                          /phone|mobile|whatsapp/i.test(header)
                        );
                        setNameColumn(nameHeader ?? headers[0]);
                        setPhoneColumn(phoneHeader ?? headers[0]);
                      }
                    }}
                  />
                </label>
                {csvRows.length > 0 && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs font-medium">
                      Name column
                      <select
                        value={nameColumn}
                        onChange={(event) => setNameColumn(event.target.value)}
                        className="border-input bg-background h-9 w-full rounded-lg border px-2"
                      >
                        {csvColumns.map((column) => (
                          <option key={column}>{column}</option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs font-medium">
                      Phone column (required)
                      <select
                        value={phoneColumn}
                        onChange={(event) => setPhoneColumn(event.target.value)}
                        className="border-input bg-background h-9 w-full rounded-lg border px-2"
                      >
                        {csvColumns.map((column) => (
                          <option key={column}>{column}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                <p className="text-muted-foreground mt-2 text-xs">
                  {csvRows.length
                    ? `${csvRows.length} rows ready to import.`
                    : 'CSV headers are mapped automatically when possible.'}
                </p>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <h2 className="text-foreground text-lg font-semibold">
                  Reminder schedule &amp; templates
                </h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  Each reminder uses an approved WhatsApp template.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => addReminder()}
              >
                <Plus data-icon="inline-start" />
                Add reminder
              </Button>
            </div>
            {templateError && (
              <p
                role="alert"
                className="text-destructive bg-destructive/10 rounded-lg p-3 text-sm"
              >
                {templateError}
              </p>
            )}
            {templates.length === 0 ? (
              <div className="border-border text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
                No approved templates found. Sync templates in WhatsApp settings
                before configuring reminders.
              </div>
            ) : reminders.length === 0 ? (
              <div className="border-border text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
                Add reminders to create a timed journey for registered
                attendees.
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {OFFSET_PRESETS.map((preset) => (
                    <Button
                      key={preset.value}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addReminder(preset.value)}
                    >
                      <Plus data-icon="inline-start" />
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="before:bg-border relative space-y-3 before:absolute before:top-6 before:bottom-6 before:left-5 before:w-px">
                {reminders.map((rule, index) => (
                  <article
                    key={rule.id}
                    className="border-border bg-background relative ml-0 rounded-xl border p-4 pl-12"
                  >
                    <span className="absolute top-4 left-3 flex size-5 items-center justify-center rounded-full bg-violet-500/15 text-violet-300">
                      <Clock3 className="size-3" />
                    </span>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-foreground text-sm font-medium">
                          {reminderLabel(rule.offset_minutes)}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          Reminder {index + 1}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete reminder"
                        onClick={() =>
                          setReminders((current) =>
                            current.filter((entry) => entry.id !== rule.id)
                          )
                        }
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1.5fr]">
                      <label className="space-y-1 text-xs font-medium">
                        Timing
                        <select
                          value={String(rule.offset_minutes)}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (Number.isSafeInteger(value))
                              updateReminder(rule.id, {
                                offset_minutes: value,
                              });
                          }}
                          className="border-input bg-background h-9 w-full rounded-lg border px-2 text-sm"
                        >
                          {OFFSET_PRESETS.map((preset) => (
                            <option key={preset.value} value={preset.value}>
                              {preset.label}
                            </option>
                          ))}
                          <option value={rule.offset_minutes}>
                            Custom ({rule.offset_minutes} minutes)
                          </option>
                        </select>
                        <span className="flex gap-2 pt-1">
                          <Input
                            aria-label="Custom offset in minutes"
                            type="number"
                            step="1"
                            value={rule.offset_minutes}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              if (Number.isSafeInteger(value))
                                updateReminder(rule.id, {
                                  offset_minutes: value,
                                });
                            }}
                          />
                          <span className="text-muted-foreground flex items-center whitespace-nowrap">
                            minutes from event
                          </span>
                        </span>
                      </label>
                      <label className="space-y-1 text-xs font-medium">
                        Approved WhatsApp template
                        <select
                          value={`${rule.template_name}:${rule.template_language ?? ''}`}
                          onChange={(event) => {
                            const selected = templates.find(
                              (template) =>
                                `${template.name}:${template.language ?? ''}` ===
                                event.target.value
                            );
                            if (selected)
                              updateReminder(rule.id, {
                                template_name: selected.name,
                                template_language: selected.language ?? 'en_US',
                              });
                          }}
                          className="border-input bg-background h-9 w-full rounded-lg border px-2 text-sm"
                        >
                          {templates.map((template) => (
                            <option
                              key={`${template.name}:${template.language}`}
                              value={`${template.name}:${template.language ?? ''}`}
                            >
                              {template.name} · {template.language ?? 'default'}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-foreground text-lg font-semibold">
                Review &amp; launch
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Review your event details, audience source, and schedule.
              </p>
            </div>
            <div className="border-border bg-background divide-border divide-y rounded-xl border">
              <div className="p-4">
                <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-orange-300 uppercase">
                  <CalendarDays className="size-4" />
                  Event
                </div>
                <p className="text-foreground mt-2 font-medium">{form.title}</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  {form.date} at {form.time} IST · {form.joinLink}
                </p>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-sky-300 uppercase">
                  <Users className="size-4" />
                  Audience
                </div>
                <p className="text-foreground mt-2 text-sm">
                  {audience === 'webhook'
                    ? 'Google Sheets / Forms webhook'
                    : audience === 'crm'
                      ? `CRM contacts${selectedTag === '__all__' ? '' : ` · ${tags.find((tag) => tag.id === selectedTag)?.name ?? 'selected tag'}`} (${eligibleContacts.length})`
                      : `CSV import (${csvRows.length} contacts)`}
                </p>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-violet-300 uppercase">
                  <Clock3 className="size-4" />
                  Reminder timeline
                </div>
                {reminders.length === 0 ? (
                  <p className="text-muted-foreground mt-2 text-sm">
                    No reminders configured.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {reminders.map((rule) => (
                      <li
                        key={rule.id}
                        className="flex flex-wrap items-center justify-between gap-2 text-sm"
                      >
                        <span className="text-foreground">
                          {reminderLabel(rule.offset_minutes)}
                        </span>
                        <Badge variant="outline">{rule.template_name}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Launching creates the event and schedules eligible reminders for
              each registration.
            </p>
          </div>
        )}

        <footer className="border-border mt-7 flex items-center justify-between border-t pt-5">
          <Button
            type="button"
            variant="outline"
            disabled={step === 0 || saving}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
          >
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button
              type="button"
              className="bg-orange-500 text-white hover:bg-orange-600"
              onClick={() => {
                if (validCurrentStep()) setStep((current) => current + 1);
              }}
            >
              Continue
              <ArrowRight data-icon="inline-end" />
            </Button>
          ) : (
            <Button
              type="button"
              disabled={saving}
              className="bg-orange-500 text-white hover:bg-orange-600"
              onClick={() => void launchCampaign()}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              Launch Campaign
            </Button>
          )}
        </footer>
      </section>
    </main>
  );
}
