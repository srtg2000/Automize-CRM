'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CalendarDays,
  Code2,
  Loader2,
  Megaphone,
  Plus,
  Radio,
  Repeat2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';

type CampaignType = 'broadcast' | 'event' | 'api';
type CampaignFilter = 'all' | CampaignType;

interface Campaign {
  id: string;
  type: CampaignType;
  title: string;
  status: string;
  createdAt: string;
  details: string;
  href: string;
}

interface WebinarRow {
  id: string;
  title: string;
  start_time: string;
  registered_count: number;
  messages_sent_count: number;
}

const filters: { id: CampaignFilter; label: string }[] = [
  { id: 'all', label: 'All Campaigns' },
  { id: 'broadcast', label: 'Broadcasts' },
  { id: 'event', label: 'Event Campaigns' },
  { id: 'api', label: 'API Campaigns' },
];

const campaignChoices = [
  {
    id: 'broadcast' as const,
    title: 'Broadcast Campaign',
    badge: 'FOR MARKETING',
    description: 'Send a one-time WhatsApp campaign now or schedule it.',
    icon: Radio,
    color: 'text-orange-400',
    background: 'bg-orange-500/10',
    href: '/broadcasts/new',
  },
  {
    id: 'event' as const,
    title: 'Event Campaign',
    badge: 'FOR EVENT REMINDERS',
    description: 'Build timed reminders for a webinar, workshop, or event.',
    icon: CalendarDays,
    color: 'text-violet-400',
    background: 'bg-violet-500/10',
    href: '/campaigns/new/event',
  },
  {
    id: 'api' as const,
    title: 'API Campaign',
    badge: 'FOR DEVELOPERS',
    description: 'Connect inbound webhooks from your website or store.',
    icon: Code2,
    color: 'text-sky-400',
    background: 'bg-sky-500/10',
    href: '/flows',
  },
  {
    id: 'recurring' as const,
    title: 'Recurring Campaign',
    badge: 'COMING SOON',
    description: 'Automate campaigns that repeat on a schedule.',
    icon: Repeat2,
    color: 'text-muted-foreground',
    background: 'bg-muted',
    href: '',
    disabled: true,
  },
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function eventStatus(startTime: string): string {
  const start = new Date(startTime).getTime();
  const now = Date.now();
  if (now < start) return 'Upcoming';
  if (now < start + 2 * 60 * 60 * 1000) return 'Live';
  return 'Completed';
}

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CampaignFilter>('all');
  const [chooseOpen, setChooseOpen] = useState(false);

  const loadCampaigns = useCallback(async () => {
    setError(null);
    try {
      const supabase = createClient();
      const [broadcastsResult, flowsResult, webinarsResponse] =
        await Promise.all([
          supabase
            .from('broadcasts')
            .select(
              'id, name, status, created_at, sent_count, total_recipients'
            )
            .order('created_at', { ascending: false }),
          supabase
            .from('flows')
            .select('id, name, status, created_at, trigger_type')
            .eq('trigger_type', 'webhook')
            .order('created_at', { ascending: false }),
          fetch('/api/webinars'),
        ]);

      if (broadcastsResult.error) throw broadcastsResult.error;
      if (flowsResult.error) throw flowsResult.error;
      const webinarsResult = (await webinarsResponse.json()) as {
        webinars?: WebinarRow[];
        error?: string;
      };
      if (!webinarsResponse.ok) {
        throw new Error(
          webinarsResult.error ?? 'Could not load event campaigns'
        );
      }

      const broadcastCampaigns: Campaign[] = (broadcastsResult.data ?? []).map(
        (broadcast) => ({
          id: broadcast.id,
          type: 'broadcast',
          title: broadcast.name,
          status: broadcast.status,
          createdAt: broadcast.created_at,
          details: `${broadcast.sent_count ?? 0} / ${broadcast.total_recipients ?? 0} messages sent`,
          href: `/broadcasts/${broadcast.id}`,
        })
      );
      const eventCampaigns: Campaign[] = (webinarsResult.webinars ?? []).map(
        (webinar) => ({
          id: webinar.id,
          type: 'event',
          title: webinar.title,
          status: eventStatus(webinar.start_time),
          createdAt: webinar.start_time,
          details: `${webinar.registered_count} registered · ${webinar.messages_sent_count} messages sent`,
          href: '/campaigns',
        })
      );
      const apiCampaigns: Campaign[] = (flowsResult.data ?? []).map((flow) => ({
        id: flow.id,
        type: 'api',
        title: flow.name,
        status: flow.status,
        createdAt: flow.created_at,
        details: 'Inbound webhook',
        href: `/flows/${flow.id}`,
      }));
      setCampaigns([...broadcastCampaigns, ...eventCampaigns, ...apiCampaigns]);
    } catch (loadError) {
      const message =
        loadError instanceof Error
          ? loadError.message
          : 'Could not load campaigns';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  const visibleCampaigns = useMemo(
    () =>
      campaigns.filter(
        (campaign) => filter === 'all' || campaign.type === filter
      ),
    [campaigns, filter]
  );

  function chooseCampaign(href: string, disabled?: boolean) {
    if (disabled) return;
    setChooseOpen(false);
    router.push(href);
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-8 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-xs font-medium text-orange-300">
            <Megaphone className="size-3.5" />
            WhatsApp campaign suite
          </div>
          <h1 className="text-foreground text-3xl font-semibold tracking-tight">
            Campaigns
          </h1>
          <p className="text-muted-foreground mt-2 max-w-xl text-sm">
            Create, launch, and track every customer campaign from one place.
          </p>
        </div>
        <Button
          onClick={() => setChooseOpen(true)}
          className="h-10 gap-2 bg-orange-500 px-4 text-white hover:bg-orange-600"
        >
          <Plus className="size-4" />
          New Campaign
        </Button>
      </header>

      <div className="border-border flex flex-wrap items-center gap-1 border-b">
        {filters.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={`relative px-4 py-3 text-sm transition-colors ${
              filter === tab.id
                ? 'text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
            {filter === tab.id && (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-orange-400" />
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex min-h-64 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-orange-400" />
        </div>
      ) : error ? (
        <div className="border-border bg-card flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border text-center">
          <p className="text-destructive text-sm">{error}</p>
          <Button variant="outline" onClick={() => void loadCampaigns()}>
            Try again
          </Button>
        </div>
      ) : visibleCampaigns.length === 0 ? (
        <div className="border-border bg-card/60 flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center">
          <span className="mb-4 rounded-2xl bg-orange-500/10 p-4 text-orange-400">
            <Megaphone className="size-7" />
          </span>
          <h2 className="text-foreground text-lg font-semibold">
            {filter === 'all'
              ? 'Your campaign workspace is ready'
              : `No ${filters.find((tab) => tab.id === filter)?.label.toLowerCase()} yet`}
          </h2>
          <p className="text-muted-foreground mt-2 max-w-md text-sm">
            Start with a WhatsApp broadcast, an event reminder series, or an
            inbound API campaign.
          </p>
          <Button
            onClick={() => setChooseOpen(true)}
            className="mt-5 bg-orange-500 text-white hover:bg-orange-600"
          >
            <Plus data-icon="inline-start" />
            New Campaign
          </Button>
        </div>
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-2xl border">
          <div className="divide-border divide-y">
            {visibleCampaigns.map((campaign) => {
              const Icon =
                campaign.type === 'broadcast'
                  ? Radio
                  : campaign.type === 'event'
                    ? CalendarDays
                    : Code2;
              return (
                <button
                  key={`${campaign.type}-${campaign.id}`}
                  type="button"
                  onClick={() => router.push(campaign.href)}
                  className="hover:bg-muted/30 flex w-full flex-col gap-3 px-5 py-4 text-left transition-colors sm:flex-row sm:items-center"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-orange-400">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground truncate text-sm font-semibold">
                        {campaign.title}
                      </span>
                      <Badge variant="outline" className="capitalize">
                        {campaign.type === 'event'
                          ? 'Event Campaign'
                          : campaign.type === 'api'
                            ? 'API Campaign'
                            : campaign.type}
                      </Badge>
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {campaign.details}
                    </span>
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    {campaign.type === 'event' ? (
                      <Users className="size-3.5" />
                    ) : null}
                    {campaign.status} · {formatDate(campaign.createdAt)}
                  </span>
                  <ArrowRight className="text-muted-foreground hidden size-4 sm:block" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Dialog open={chooseOpen} onOpenChange={setChooseOpen}>
        <DialogContent className="border-border bg-card max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl">Choose campaign type</DialogTitle>
            <DialogDescription>
              Pick the campaign that fits your next customer moment.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {campaignChoices.map((choice) => {
              const Icon = choice.icon;
              return (
                <button
                  key={choice.id}
                  type="button"
                  disabled={choice.disabled}
                  onClick={() => chooseCampaign(choice.href, choice.disabled)}
                  className={`border-border group flex min-h-44 flex-col rounded-xl border p-4 text-left transition ${
                    choice.disabled
                      ? 'cursor-not-allowed opacity-55'
                      : 'hover:bg-muted/30 hover:border-orange-500/40'
                  }`}
                >
                  <span className="flex w-full items-start justify-between">
                    <span
                      className={`rounded-lg p-2.5 ${choice.background} ${choice.color}`}
                    >
                      <Icon className="size-5" />
                    </span>
                    <Badge
                      variant="outline"
                      className="border-border text-muted-foreground text-[9px] tracking-wide"
                    >
                      {choice.badge}
                    </Badge>
                  </span>
                  <span className="text-foreground mt-4 flex w-full items-center justify-between font-semibold">
                    {choice.title}
                    <ArrowRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-1" />
                  </span>
                  <span className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {choice.description}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
