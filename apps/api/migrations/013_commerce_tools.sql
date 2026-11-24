-- Phase 6D: tax estimates, card-dispute (chargeback) tracking and evidence, listing renewal.

ALTER TABLE listings ADD COLUMN renewed_at timestamptz;

-- Rates used ONLY to estimate the tax on twiqo's own fees for accounting and receipts. They are defaults, not advice: confirm them with your accountant.
CREATE TABLE tax_rates (
  province char(2) PRIMARY KEY,
  gst_bps int NOT NULL DEFAULT 0, pst_bps int NOT NULL DEFAULT 0, hst_bps int NOT NULL DEFAULT 0,
  note text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tax_rates(province, gst_bps, pst_bps, hst_bps, note) VALUES
 ('AB',500,0,0,'GST only'),('BC',500,700,0,'GST + PST'),('SK',500,600,0,'GST + PST'),('MB',500,700,0,'GST + RST'),
 ('ON',0,0,1300,'HST'),('QC',500,998,0,'GST + QST (9.975%)'),('NB',0,0,1500,'HST'),('NS',0,0,1400,'HST (verify current rate)'),
 ('NL',0,0,1500,'HST'),('PE',0,0,1500,'HST'),('YT',500,0,0,'GST only'),('NT',500,0,0,'GST only'),('NU',500,0,0,'GST only');

CREATE TABLE card_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_dispute_id text NOT NULL UNIQUE,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  amount_cents int NOT NULL, currency char(3) NOT NULL DEFAULT 'CAD',
  reason text, status text NOT NULL,
  due_by timestamptz, evidence_submitted_at timestamptz, evidence_submitted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_disputes_open_idx ON card_disputes(due_by) WHERE status IN ('needs_response','warning_needs_response');
