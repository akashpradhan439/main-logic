# Table: `countries`

Static reference table. Maps ISO country codes to human-readable names, dialling prefixes, currencies, and flag assets. Used by the registration flow to populate country pickers and validate `users.country_code`.

RLS: **disabled**.  
Row count: 0 (seeded externally; check Supabase dashboard for seed data).

---

## Columns

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `country_code` | `text` | NO | — | ISO 3166-1 alpha-2 code (e.g. `"IN"`, `"US"`). Primary key. Must match values used in `users.country_code`. |
| `country_name` | `text` | YES | — | Human-readable country name (e.g. `"India"`). |
| `phone_code` | `text` | YES | — | International dialling prefix including `+` (e.g. `"+91"`). |
| `currency_name` | `text` | YES | — | Currency name (e.g. `"Indian Rupee"`). |
| `flag_url` | `text` | YES | — | URL to the country flag image asset. |
| `continent` | `text` | YES | — | Continent name (e.g. `"Asia"`). |

---

## Constraints

| Name | Type | Columns |
|---|---|---|
| `countries_pkey` | PRIMARY KEY | `country_code` |

---

## Indexes

| Name | Definition |
|---|---|
| `countries_pkey` | UNIQUE btree `(country_code)` |

---

## Notes

- There is no FK from `users.country_code` to `countries.country_code` in the current schema. Referential integrity between the two is enforced at the application level.
- This table carries no row-level sensitivity; RLS is unnecessary.
