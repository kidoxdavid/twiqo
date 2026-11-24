-- Phase 7: voice messages and shipment bundles.

ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','image','attachment','offer','booking','system','voice'));
ALTER TABLE messages ADD COLUMN audio_key text, ADD COLUMN audio_ms int CHECK (audio_ms IS NULL OR audio_ms BETWEEN 300 AND 125000);

-- several shipments offered to (or by) one driver together; each stays its own offer and its own booking
ALTER TABLE offers ADD COLUMN bundle_id uuid;
CREATE INDEX offers_bundle_idx ON offers(bundle_id) WHERE bundle_id IS NOT NULL;

INSERT INTO platform_settings(key, value, description) VALUES
 ('voice.max_seconds', '120', 'Longest voice message'),
 ('voice.retention_days', '180', 'Voice recordings are deleted after this many days (the message stays, marked expired)'),
 ('bundle.max_shipments', '6', 'Most shipments in one bundle');
