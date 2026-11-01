'use strict';
/**
 * lib/howto.js — The How To Room (additive, Nov 1 2026).
 *
 * Davena's How To Room: live sessions teaching one money play at a time.
 * The front door is a free registration (POST /howto) styled on the
 * Beginner Brand confirmation pattern she chose: register -> confirmation
 * page with an 80% progress bar, a welcome-video slot, and Step 1
 * "Add the Event to Your Calendar" (the meeting link rides inside the
 * calendar event). Inside the Wealth Builder's Room, the How To tab
 * lists plays on three one-time upgrade shelves ($49 / $99 / $199).
 *
 * Config (env, set on Render):
 *   HOWTO_MEETING_URL        — the live session link (Zoom etc.). Until
 *                              Davena sets it, the placeholder below is
 *                              used so the calendar file still generates.
 *   HOWTO_WELCOME_VIDEO_URL  — welcome video for /howto/confirm. A direct
 *                              .mp4 renders a <video>; anything else is
 *                              iframed as an embed. Empty = friendly
 *                              "video coming" panel.
 *   HOWTO_SHELF49_URL / HOWTO_SHELF99_URL / HOWTO_SHELF199_URL
 *                            — Stripe checkout/payment links for the
 *                              shelves. Empty = the tab shows an honest
 *                              "checkout opens shortly" note (no fake
 *                              buttons, no dead links).
 */

// Session 1 — Thu Nov 5, 2026, 7:00–8:30 PM America/Chicago (CST, UTC-6).
const SESSION = {
  id: 'howto-session-1',
  source: 'howto-session-1',
  number: 1,
  title: 'How to Make Amazon Books for This 4th Quarter',
  eventTitle: 'How To Room — Session 1: How to Make Amazon Books for This 4th Quarter',
  // 2026-11-05 19:00 CST = 2026-11-06T01:00:00Z; ends 20:30 CST.
  startMs: Date.UTC(2026, 10, 6, 1, 0, 0),
  endMs: Date.UTC(2026, 10, 6, 2, 30, 0),
  whenText: 'Thursday, November 5, 2026 · 7:00–8:30 PM CT',
  description:
    'A live How To Room session with Davena Blue: create your own Amazon ' +
    'book for the 4th quarter — no inventory, Amazon prints and ships. ' +
    'This training is live and there are no replays.',
};

function meetingUrl() {
  return (process.env.HOWTO_MEETING_URL || '').trim() || 'REPLACE_WITH_ZOOM_LINK';
}

function welcomeVideoUrl() {
  return (process.env.HOWTO_WELCOME_VIDEO_URL || '').trim();
}

/**
 * The three upgrade shelves shown on the How To tab (Davena's ladder,
 * Nov 1 2026): $49 "learn those" · $99 "learn this" · $199 "learn that"
 * (the $199 shelf carries the hand-holding). One-time charges; the only
 * subscription in the house stays the Room's $49/month.
 */
const SHELVES = [
  {
    id: 'shelf-49',
    priceCents: 4900,
    priceDisplay: '$49',
    name: 'Learn Those',
    tagline: 'The starter shelf — the foundational plays.',
    checkoutEnv: 'HOWTO_SHELF49_URL',
    plays: [
      { title: 'Starter plays — first sessions land here', note: 'New foundational how-tos are added to this shelf as they are taught.' },
    ],
  },
  {
    id: 'shelf-99',
    priceCents: 9900,
    priceDisplay: '$99',
    name: 'Learn This',
    tagline: 'The next shelf — full plays, taught start to finish.',
    checkoutEnv: 'HOWTO_SHELF99_URL',
    plays: [
      {
        title: 'Building an Amazon Book — Session 1',
        note: '“How to Make Amazon Books for This 4th Quarter.” Create your own book, through the will of God — no two are the same, each journey is different. Replay + workbook unlock on this shelf.',
        featured: true,
      },
    ],
  },
  {
    id: 'shelf-199',
    priceCents: 19900,
    priceDisplay: '$199',
    name: 'Learn That — Hand-Holding',
    tagline: 'The deepest shelf — the plays, plus a hand held through them.',
    checkoutEnv: 'HOWTO_SHELF199_URL',
    plays: [
      {
        title: 'Building an Amazon Book — with hand-holding',
        note: 'Everything on the $99 shelf for this play, plus help with anything you come against — upload errors, cover rejections, keyword and pricing calls — until your book is live on Amazon.',
        featured: true,
      },
    ],
  },
];

function shelvesWithCheckout() {
  return SHELVES.map((s) => ({
    ...s,
    checkoutUrl: (process.env[s.checkoutEnv] || '').trim(),
  }));
}

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** A single-event .ics for Session 1, with the meeting link inside. */
function buildIcs(now = Date.now()) {
  const loc = meetingUrl();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TransitNow//How To Room//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${SESSION.id}@funnel-qdx9.onrender.com`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(SESSION.startMs)}`,
    `DTEND:${icsDate(SESSION.endMs)}`,
    `SUMMARY:${icsEscape(SESSION.eventTitle)}`,
    `DESCRIPTION:${icsEscape(`${SESSION.description}\n\nJoin here: ${loc}\n\n7:00–8:30 PM Central. Live only — no replays.`)}`,
    `LOCATION:${icsEscape(loc)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT60M',
    'ACTION:DISPLAY',
    'DESCRIPTION:How To Room Session 1 starts in 1 hour',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** "Add to Google Calendar" template link with the same details. */
function googleCalendarUrl() {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: SESSION.eventTitle,
    dates: `${icsDate(SESSION.startMs)}/${icsDate(SESSION.endMs)}`,
    details: `${SESSION.description}\n\nJoin here: ${meetingUrl()}\n\n7:00–8:30 PM Central. Live only — no replays.`,
    location: meetingUrl(),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

module.exports = {
  SESSION,
  SHELVES,
  meetingUrl,
  welcomeVideoUrl,
  shelvesWithCheckout,
  buildIcs,
  googleCalendarUrl,
};
