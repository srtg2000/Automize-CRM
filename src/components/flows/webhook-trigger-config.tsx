'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy, FileSpreadsheet, Plus, Trash2, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface CustomFieldMapping {
  header: string;
  field_name: string;
}

interface FieldMappings {
  phone_header?: string;
  name_header?: string;
  email_header?: string;
  tags_header?: string;
  custom_fields?: CustomFieldMapping[];
}

interface WebhookTriggerConfigProps {
  flowId: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

export function WebhookTriggerConfig({
  flowId,
  config,
  onChange,
}: WebhookTriggerConfigProps) {
  const t = useTranslations('Flows.builder');
  const [mappingOpen, setMappingOpen] = useState(false);
  const [captureToken, setCaptureToken] = useState<string | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const fields = useMemo(
    () =>
      Array.isArray(config.captured_fields)
        ? config.captured_fields.filter(
            (field): field is string => typeof field === 'string'
          )
        : [],
    [config.captured_fields]
  );
  const mappings = useMemo(
    () =>
      config.field_mappings && typeof config.field_mappings === 'object'
        ? (config.field_mappings as FieldMappings)
        : {},
    [config.field_mappings]
  );
  const webhookUrl =
    typeof window === 'undefined'
      ? `/api/automations/webhook/${flowId}`
      : `${window.location.origin}/api/automations/webhook/${flowId}`;
  const captureUrl = captureToken
    ? `${webhookUrl}?capture_token=${captureToken}`
    : webhookUrl;
  const script = `function onFormSubmit(e) {
  const row = e.namedValues;
  const payload = {};
  Object.keys(row).forEach((header) => {
    payload[header] = Array.isArray(row[header]) ? row[header][0] : row[header];
  });

  UrlFetchApp.fetch('${captureUrl}', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
  });
}`;

  useEffect(() => {
    if (!captureToken) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/flows/${flowId}/webhook-capture?token=${encodeURIComponent(captureToken)}`
        );
        if (response.status === 410) {
          if (!cancelled) {
            setCaptureToken(null);
            setCaptureBusy(false);
            toast.error(t('webhookCaptureExpired'));
          }
          return;
        }
        if (!response.ok) throw new Error(t('webhookCaptureFailed'));
        const result = (await response.json()) as {
          fields: unknown;
          captured_at: string | null;
        };
        if (Array.isArray(result.fields) && result.fields.length > 0) {
          if (!cancelled) {
            onChange({
              ...config,
              captured_fields: result.fields,
            });
            setCaptureToken(null);
            setCaptureBusy(false);
            toast.success(t('webhookFieldsCaptured'));
          }
          return;
        }
        if (!cancelled) timer = setTimeout(poll, 2000);
      } catch (error) {
        if (!cancelled) {
          setCaptureToken(null);
          setCaptureBusy(false);
          toast.error(
            error instanceof Error ? error.message : t('webhookCaptureFailed')
          );
        }
      }
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [captureToken, config, flowId, onChange, t]);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('webhookCopied'));
    } catch {
      toast.error(t('webhookCopyFailed'));
    }
  }

  async function startCapture() {
    setCaptureBusy(true);
    try {
      const response = await fetch(`/api/flows/${flowId}/webhook-capture`, {
        method: 'POST',
      });
      const result = (await response.json()) as {
        token?: string;
        error?: string;
      };
      if (!response.ok || !result.token) {
        throw new Error(result.error ?? t('webhookCaptureFailed'));
      }
      setCaptureToken(result.token);
      toast.success(t('webhookListening'));
    } catch (error) {
      setCaptureBusy(false);
      toast.error(
        error instanceof Error ? error.message : t('webhookCaptureFailed')
      );
    }
  }

  function updateMappings(next: FieldMappings) {
    onChange({ ...config, field_mappings: next });
  }

  function headerSelect(
    value: string | undefined,
    onValueChange: (next: string | null) => void,
    placeholder: string
  ) {
    return (
      <Select
        value={value || ''}
        onValueChange={(next) => {
          if (next !== null) onValueChange(next);
        }}
        disabled={fields.length === 0}
      >
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {fields.map((field) => (
            <SelectItem key={field} value={field}>
              {field}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <section className="border-border bg-card mt-4 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
          <Webhook className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground text-sm font-semibold">
            {t('webhookTriggerTitle')}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('webhookTriggerDescription')}
          </p>
        </div>
        <FileSpreadsheet className="text-muted-foreground size-5 shrink-0" />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Input aria-label={t('webhookEndpoint')} readOnly value={captureUrl} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('webhookCopyUrl')}
          onClick={() => void copy(captureUrl)}
        >
          <Copy />
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={captureBusy}
          onClick={() => void startCapture()}
        >
          <Webhook />
          {captureBusy ? t('webhookListening') : t('webhookCaptureButton')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setMappingOpen(true)}
        >
          {t('webhookMappingButton')}
        </Button>
      </div>

      {captureToken && (
        <p className="text-muted-foreground mt-2 text-xs">
          {t('webhookCaptureInstructions')}
        </p>
      )}

      <details className="border-border mt-4 rounded-lg border">
        <summary className="text-foreground flex cursor-pointer list-none items-center gap-2 p-3 text-xs font-medium">
          <FileSpreadsheet className="size-4" />
          {t('webhookAppsScript')}
        </summary>
        <div className="border-border border-t p-3">
          <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 text-xs">
            <code>{script}</code>
          </pre>
          <Button
            type="button"
            className="mt-2"
            size="sm"
            variant="secondary"
            onClick={() => void copy(script)}
          >
            <Copy />
            {t('webhookCopyScript')}
          </Button>
        </div>
      </details>

      <Dialog open={mappingOpen} onOpenChange={setMappingOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('webhookMappingTitle')}</DialogTitle>
            <DialogDescription>
              {t('webhookMappingDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {(
              [
                ['phone_header', t('webhookPhoneMapping'), true],
                ['name_header', t('webhookNameMapping'), false],
                ['email_header', t('webhookEmailMapping'), false],
                ['tags_header', t('webhookTagsMapping'), false],
              ] as const
            ).map(([key, label, required]) => (
              <label key={key} className="flex flex-col gap-1.5 text-xs">
                <span className="text-foreground font-medium">
                  {label}
                  {required ? ' *' : ''}
                </span>
                {headerSelect(
                  mappings[key],
                  (value) => updateMappings({ ...mappings, [key]: value }),
                  fields.length
                    ? t('webhookChooseColumn')
                    : t('webhookCaptureFirst')
                )}
              </label>
            ))}

            <div className="border-border flex flex-col gap-2 border-t pt-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-foreground text-xs font-semibold">
                  {t('webhookCustomFields')}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    updateMappings({
                      ...mappings,
                      custom_fields: [
                        ...(mappings.custom_fields ?? []),
                        { header: fields[0] ?? '', field_name: '' },
                      ],
                    })
                  }
                >
                  <Plus />
                  {t('webhookAddMapping')}
                </Button>
              </div>
              {(mappings.custom_fields ?? []).map((mapping, index) => (
                <div
                  key={`${mapping.header}-${index}`}
                  className="flex items-center gap-2"
                >
                  <div className="min-w-0 flex-1">
                    {headerSelect(
                      mapping.header,
                      (header) =>
                        updateMappings({
                          ...mappings,
                          custom_fields: (mappings.custom_fields ?? []).map(
                            (entry, current) =>
                              current === index
                                ? { ...entry, header: header ?? '' }
                                : entry
                          ),
                        }),
                      t('webhookChooseColumn')
                    )}
                  </div>
                  <Input
                    aria-label={t('webhookCrmFieldName')}
                    placeholder={t('webhookCrmFieldName')}
                    value={mapping.field_name}
                    onChange={(event) =>
                      updateMappings({
                        ...mappings,
                        custom_fields: (mappings.custom_fields ?? []).map(
                          (entry, current) =>
                            current === index
                              ? { ...entry, field_name: event.target.value }
                              : entry
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('webhookRemoveMapping')}
                    onClick={() =>
                      updateMappings({
                        ...mappings,
                        custom_fields: (mappings.custom_fields ?? []).filter(
                          (_, current) => current !== index
                        ),
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
