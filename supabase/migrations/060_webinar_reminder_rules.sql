ALTER TABLE public.webinars
  ADD COLUMN IF NOT EXISTS reminder_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.webinars
  DROP CONSTRAINT IF EXISTS webinars_reminder_rules_is_array;

ALTER TABLE public.webinars
  ADD CONSTRAINT webinars_reminder_rules_is_array
  CHECK (jsonb_typeof(reminder_rules) = 'array');
