-- Delivery results for SMS (Phase 4). status says whether the provider
-- took the message; delivery_status is what happened to it afterwards, as
-- reported by the provider (Brevo: delivered, rejected, blocked, bounced...).
ALTER TABLE sms_messages ADD COLUMN delivery_status VARCHAR(30);
ALTER TABLE sms_messages ADD COLUMN delivery_at TIMESTAMPTZ;
ALTER TABLE sms_messages ADD COLUMN delivery_checked_at TIMESTAMPTZ;
CREATE INDEX idx_sms_messages_pending_delivery ON sms_messages (created_at)
    WHERE status = 'sent' AND provider = 'brevo';
