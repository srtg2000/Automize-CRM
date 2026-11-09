CREATE TABLE IF NOT EXISTS public.webinars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  title TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  join_link TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.webinars
  ADD COLUMN IF NOT EXISTS reminder_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.webinars
  DROP CONSTRAINT IF EXISTS webinars_reminder_rules_is_array;

ALTER TABLE public.webinars
  ADD CONSTRAINT webinars_reminder_rules_is_array
  CHECK (jsonb_typeof(reminder_rules) = 'array');
