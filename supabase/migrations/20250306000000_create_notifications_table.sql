-- Notifications table for hex overlap deduplication (24-hour symmetric pair check)
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id uuid NOT NULL,
  user_b_id uuid NOT NULL,
  initiator_id uuid NOT NULL,
  overlap_hex text NOT NULL,
  notification_type text NOT NULL DEFAULT 'hex_overlap',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for efficient 24-hour dedup queries: find recent notifications for a user pair
CREATE INDEX IF NOT EXISTS idx_notifications_pair_created
  ON notifications (user_a_id, user_b_id, created_at DESC);

-- Index for initiator lookups if needed
CREATE INDEX IF NOT EXISTS idx_notifications_initiator
  ON notifications (initiator_id, created_at DESC);
