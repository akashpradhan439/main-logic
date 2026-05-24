# Language Preference API

## Overview

Users can configure a display/AI language preference that controls the language of all AI-generated text (connection suggestions, interest suggestions, meet-up suggestions). The preference is stored on the user record and returned on login/signup so the client can apply it immediately.

Supported language codes:

| Code | Language |
|------|----------|
| `en` | English (default) |
| `ar` | Arabic |
| `bn` | Bangla |
| `es` | Spanish |
| `fr` | French |
| `hi` | Hindi |
| `ja` | Japanese |
| `pt` | Portuguese |
| `ru` | Russian |
| `zh-Hans` | Chinese (Simplified) |
| `zh-Hant` | Chinese (Traditional) |

---

## Signup

### `POST /functions/v1/signup`

An optional `language_preference` field can be included in the signup body. If omitted, the user defaults to `en`.

#### Request body

```ts
{
  country_code: string;        // e.g. "+91"
  phone_number: number;
  password: string;
  dob: string;                 // "YYYY-MM-DD"
  first_name: string;
  last_name: string;
  code: string;                // OTP
  language_preference?: string; // optional — one of the supported codes above
}
```

#### Response — 201 Created

```json
{
  "message": "User created and logged in",
  "access_token": "<jwt>",
  "refresh_token": "<jwt>",
  "expires_in": 600,
  "user": {
    "id": "161a6dd6-5eda-419d-8e6e-153947d644f2",
    "phone": "+919000000000",
    "language_preference": "hi"
  }
}
```

#### Response — 400 Bad Request (invalid code)

Returned when `language_preference` is present but not one of the supported codes.

```json
{
  "error": "Invalid language_preference",
  "supported": ["en","ar","bn","es","fr","hi","ja","pt","ru","zh-Hans","zh-Hant"]
}
```

---

## Login

### `POST /functions/v1/login`

No changes to the request body. The response now includes `language_preference` in the `user` object so the client can restore the user's language setting immediately on login.

#### Request body (unchanged)

```ts
{
  country_code: string;
  phone_number: number;
  password: string;
  force_login?: boolean;
  force_login_token?: string;
}
```

#### Response — 200 OK

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<jwt>",
  "expires_in": 600,
  "user": {
    "id": "161a6dd6-5eda-419d-8e6e-153947d644f2",
    "phone": "+919000000000",
    "language_preference": "hi"
  }
}
```

---

## Update Language Preference

### `PATCH /profile/language`

Updates the authenticated user's language preference. The new value takes effect on the next AI suggestion request (cache is keyed by language, so a language change bypasses any stale cached suggestions).

**Auth:** required — `Authorization: Bearer <access_token>`

#### Request body

```ts
{
  language_preference: string; // must be one of the supported codes
}
```

#### Response — 200 OK

```json
{
  "success": true,
  "languagePreference": "hi"
}
```

#### Response — 400 Bad Request

Returned when the code is missing or not in the supported list.

```json
{
  "success": false,
  "error": "common.errors.invalid_parameter",
  "supported": ["en","ar","bn","es","fr","hi","ja","pt","ru","zh-Hans","zh-Hant"]
}
```

#### Response — 401 Unauthorized

```json
{
  "success": false,
  "error": "common.errors.auth_required"
}
```

---

## Effect on AI endpoints

Once a user's `language_preference` is set, all AI-generated text is returned in that language automatically — no extra parameter is needed on any AI endpoint.

| Endpoint | Affected field(s) |
|----------|-------------------|
| `GET /ai/connections/suggestions` | `reason` per suggestion |
| `POST /ai/interests/suggestions` | items in `interests` array |
| `GET /ai/meetup/suggestions` | `title`, `time`, `text` per suggestion |

The client does not need to pass a language header or parameter to any of these endpoints.
