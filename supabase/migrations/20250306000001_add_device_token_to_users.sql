-- Add device_token for APNs push notifications (iOS)
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_token text;
