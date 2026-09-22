# TransitNow Live Operations Video System — Spec

**Directive (user, 2026-09-20):** Real live video support inside the existing TransitNow app. Integrate with existing drivers, routes, packages, custody, exceptions, support, community, training, client contracts, notifications, and audits. Do NOT create duplicate driver/package records. **"DO NOT FAKE THE VIDEO."**

## Absolute rules

- DO NOT create a separate application. DO NOT rebuild the existing TransitNow platform. DO NOT remove or break any existing features.
- If no provider is connected, label the architecture/UI **"VIDEO PROVIDER REQUIRED."**
- Label unavailable device tests **"SIMULATED TEST."**
- Never call simulated behavior live, instant, real-time, or connected.
- Do not claim staffed 24/7 human support; requests may be submitted 24/7, but response depends on coverage.
- Video is private by default. Recording is OFF by default and requires explicit consent, visible notice, and an indicator.
- Never activate camera, microphone, or location without permission. Location sharing is voluntary and visibly on/off.
- Secrets remain server-side. Never expose provider secrets or the admin token in frontend code.
- Do not claim provider-backed behavior is reliable until credentials are configured AND a genuine end-to-end call succeeds.

## Provider abstraction

- `VideoProvider` interface implemented by concrete providers (e.g. Daily, Twilio Video, Agora). Switching providers = config change, not code change.
- Required env vars: `VIDEO_PROVIDER`, `VIDEO_API_KEY`, `VIDEO_API_SECRET`, `VIDEO_PROJECT_ID`, `VIDEO_WEBHOOK_SECRET`. Document all in `.env.example` without values.
- When `VIDEO_PROVIDER` is unset or credentials missing: the "GO LIVE WITH OPERATIONS" UI shows **"VIDEO PROVIDER REQUIRED"** and explains a real provider must be connected. Session request/accept/record lifecycle still works as **SIMULATED TEST** so the workflow can be exercised without faking media.

## Data models

- `live_sessions`: id, session_id (public), driver_id, dispatcher/staff name, route_id, contract_id, priority (NORMAL/HIGH/URGENT), reason, status (REQUESTED, ACCEPTED, LIVE, ENDED, MISSED, DECLINED), started_at, ended_at, consent flags, notes, provider session reference.
- `live_participants`: session_id, user/driver, role, joined_at, left_at.
- `live_session_events`: session_id, event type, timestamp, actor, details (append-only).
- `live_session_messages`: session_id, sender, message, timestamp (chat during session).
- `live_session_recordings`: session_id, storage reference, consent record, retention expiry, access log reference. Recording requires explicit opt-in consent BEFORE recording starts; visible indicator during; access restricted to admin roles and logged.
- `live_support_requests`: driver_id, reason, priority, status, created_at, resolved_at.
- `live_training_events`, `live_training_attendance`, `video_training_content`: training session scheduling, attendance, and training content library records (provider-backed when live, clearly labeled when not).

## Lifecycle

1. Driver taps "GO LIVE WITH OPERATIONS" → creates `live_support_requests` + `live_sessions` row (REQUESTED), alerts operations (notification queue).
2. Dispatcher accepts → ACCEPTED; both join → LIVE. Driver must explicitly accept before their camera/mic activates.
3. Chat messages and session events logged append-only.
4. Session ends → ENDED with timestamps and notes. Recording, if consented, is stored with access logging and a retention policy.

## Frontend

- Driver mobile view: big GO LIVE button, visible mic/camera/location toggles, clear "VIDEO PROVIDER REQUIRED" state when unconfigured.
- Permissions requested explicitly via browser APIs; never auto-activate.
- When provider is configured and media connects: show connected state; otherwise never imply a live connection.

## Testing

- Full lifecycle test with provider unset → labeled SIMULATED TEST.
- Never mark video "live"/"real-time"/"connected" unless a genuine end-to-end media call succeeded with configured credentials (which requires the user to configure credentials first).
