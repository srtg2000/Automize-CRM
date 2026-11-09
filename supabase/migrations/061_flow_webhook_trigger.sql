ALTER TABLE flows
  DROP CONSTRAINT IF EXISTS flows_trigger_type_check;

ALTER TABLE flows
  ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'webhook'));

CREATE TABLE IF NOT EXISTS flow_webhook_captures (
  token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  captured_fields JSONB,
  captured_payload JSONB,
  captured_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_webhook_captures_flow_expiry
  ON flow_webhook_captures(flow_id, expires_at DESC);

ALTER TABLE flow_webhook_captures ENABLE ROW LEVEL SECURITY;
