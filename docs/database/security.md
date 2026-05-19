# RLS Policies & Security

---

## Row Level Security Status

| Table | RLS Enabled | Policies |
|---|---|---|
| `users` | NO | none |
| `connections` | NO | none |
| `conversations` | NO | none |
| `messages` | NO | none |
| `user_prekeys` | NO | none |
| `one_time_prekeys` | NO | none |
| `notifications` | NO | none |
| `connection_proximity_notifications` | NO | none |
| `countries` | NO | none |
| `expired_tokens` | **YES** | `service_role` — ALL |
| `security_incidents` | **YES** | `service_role` — ALL |

> **Warning:** 9 out of 11 tables have RLS disabled. Because the API exclusively uses the Supabase **service-role key** (never the anon key) from a private server, all access control is enforced at the API layer (JWT verification, participant checks, block checks) rather than in the database. This is intentional for a backend-only architecture but means the database itself has no row-level guardrails if the service-role key were ever exposed.

---

## Active Policies

### `expired_tokens` — "Service role only"

```sql
CREATE POLICY "Service role only"
  ON public.expired_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
```

Full read/write for the service role. All other roles (anon, authenticated) are blocked by RLS.

### `security_incidents` — "Service role only"

```sql
CREATE POLICY "Service role only"
  ON public.security_incidents
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
```

Same pattern. Security incident rows are write-only from the API and never exposed to clients.

---

## Access Control Architecture

Since the Supabase client libraries (anon/authenticated keys) are not used by end clients in this system, the threat model is:

1. **All data access goes through the Fastify API** — the app never ships the Supabase URL or service-role key to mobile clients.
2. **JWT middleware** (`shared/auth.ts`) verifies every request before touching the database.
3. **Participant checks** in `lib/messaging.ts` (`verifyConversationParticipant`) and connection checks in `lib/connections.ts` enforce object-level access.
4. **Block checks** (`isPairBlocked`) prevent blocked users from sending or receiving messages.

---

## Enabling RLS (Reference SQL)

If direct Supabase client access is ever introduced, RLS should be enabled. The following SQL enables RLS on all unprotected tables — **do not run without also adding appropriate policies**, as enabling RLS without policies blocks all access:

```sql
ALTER TABLE public.users                             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connections                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_prekeys                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.one_time_prekeys                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_proximity_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.countries                         ENABLE ROW LEVEL SECURITY;
```

Example policies for a client-facing setup would include:
- `users`: users can only read/update their own row.
- `messages`: users can only read messages in conversations they participate in.
- `connections`: users can only read connections where they are `requester_id` or `addressee_id`.
