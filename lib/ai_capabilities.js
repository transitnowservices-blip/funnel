'use strict';
/**
 * lib/ai_capabilities.js — What the private operations assistant can do.
 *
 * Davena's rule: drivers (and Room members) see the ACTUAL NUMBER of
 * concrete things the assistant can create/do with them, and get a FRESH
 * list each week. These catalogs are the source of truth for the dashboard
 * panel ("your assistant can do N things with you") and the Monday emails.
 *
 * Only real, fulfillable items belong here — things the assistant genuinely
 * delivers through the Q&A workflow (lib/ai_assistant.js). Public copy
 * NEVER names the AI or any vendor/model ("private AI operations assistant"
 * only), and NEVER promises earnings, income, routes, loads, or work.
 *
 * weeklySpotlight(catalog, weekKey) returns 3 items that rotate every week,
 * deterministic for a given ISO week key ("2026-W39"), so every week is
 * genuinely new until the catalog wraps around.
 */
const DRIVER_CAPABILITIES = [
  { id: 'weekly-route-plan', title: 'Weekly route plan',
    description: 'A Monday-ready plan built around your matches and your weekly goal.',
    example_ask: 'Build my route plan for this week from my 5 matches.' },
  { id: 'broker-outreach-draft', title: 'Broker outreach emails',
    description: 'Professional drafts you can send to brokers about a lane.',
    example_ask: 'Draft an email to a broker asking about their Milwaukee outbound lanes.' },
  { id: 'rate-talk-points', title: 'Rate negotiation talking points',
    description: 'What to say when an offered rate is too low.',
    example_ask: 'A broker offered a low rate on a 400-mile lane — how do I counter?' },
  { id: 'paperwork-checklist', title: 'Paperwork checklists',
    description: 'What to carry in the truck and what to file after delivery.',
    example_ask: 'What paperwork do I need in the truck this week?' },
  { id: 'expense-tracking', title: 'Expense tracking setup',
    description: 'A simple system to track fuel, tolls, and maintenance spending.',
    example_ask: 'Help me set up a weekly expense tracker.' },
  { id: 'goal-review', title: 'Weekly goal review',
    description: 'Compare your assigned matches against the weekly goal you set.',
    example_ask: 'Am I on track for the weekly goal I set?' },
  { id: 'maintenance-schedule', title: 'Vehicle maintenance schedule',
    description: 'Mileage-based upkeep plan so nothing breaks down mid-route.',
    example_ask: 'Build a maintenance schedule for my cargo van at 120,000 miles.' },
  { id: 'entity-checklist', title: 'Business setup checklist',
    description: 'LLC, EIN, operating authority — the steps in the right order.',
    example_ask: 'What are the steps to set up my LLC and get my EIN?' },
  { id: 'lane-research', title: 'Lane research briefs',
    description: 'What to know before you commit to running a new lane.',
    example_ask: 'What should I research before running Chicago to Indianapolis?' },
  { id: 'broker-verification', title: 'Broker verification walkthrough',
    description: 'How to check out a broker before you haul for them.',
    example_ask: 'Walk me through verifying a new broker.' },
  { id: 'delivery-comms', title: 'Customer communication templates',
    description: 'Professional pickup and delivery update messages.',
    example_ask: 'Draft a template I can send when a delivery is delayed.' },
  { id: 'weekly-debrief', title: 'Weekly debrief',
    description: 'Review what worked this week and plan the next one.',
    example_ask: 'Help me debrief this week and plan next week.' },
];

const ROOM_CAPABILITIES = [
  { id: 'ninety-day-plan', title: '90-day plan draft',
    description: 'A written 90-day plan built around your goal, in your words.',
    example_ask: 'Draft my 90-day plan around growing my business.' },
  { id: 'pricing-walkthrough', title: 'Pricing walkthrough',
    description: 'Work through your numbers until your price makes sense.',
    example_ask: 'Walk me through pricing my service.' },
  { id: 'content-calendar', title: 'Weekly content calendar',
    description: 'Seven days of post ideas for your business.',
    example_ask: "Build this week's content calendar for my business." },
  { id: 'offer-teardown', title: 'Offer teardown',
    description: 'An honest review of your offer, line by line.',
    example_ask: 'Tear down my workshop offer.' },
  { id: 'budget-review', title: 'Budget review',
    description: 'Where your money goes and what to change.',
    example_ask: 'Review my monthly business budget.' },
  { id: 'accountability-plan', title: 'Accountability plan',
    description: 'Daily check-ins built around your 90-day goal.',
    example_ask: 'Build my daily accountability plan.' },
  { id: 'sales-script', title: 'Sales conversation script',
    description: 'What to say when someone is interested in buying.',
    example_ask: 'Write a script for my discovery calls.' },
  { id: 'followup-messages', title: 'Follow-up messages',
    description: 'What to send when people go quiet.',
    example_ask: 'Draft three follow-ups for my quote requests.' },
  { id: 'milestone-map', title: 'Milestone map',
    description: 'Break a big goal into weekly wins.',
    example_ask: 'Map my revenue goal into weekly milestones.' },
  { id: 'weekly-review', title: 'Weekly business review',
    description: 'Look back at the week, learn, and plan ahead.',
    example_ask: 'Help me review my week and plan the next one.' },
];

/**
 * Three spotlight capabilities for a given ISO week key ("2026-W39").
 * Deterministic: same week -> same three. Rotates each week so the list is
 * genuinely fresh until the catalog wraps.
 */
function weeklySpotlight(catalog, weekKey) {
  const list = Array.isArray(catalog) ? catalog : [];
  if (!list.length) return [];
  const m = /^(\d{4})-W(\d{1,2})$/.exec(String(weekKey || ''));
  const seed = m ? Number(m[1]) * 53 + Number(m[2]) : 0;
  const out = [];
  for (let i = 0; i < 3 && i < list.length; i++) {
    out.push(list[(seed + i) % list.length]);
  }
  return out;
}

module.exports = {
  DRIVER_CAPABILITIES,
  ROOM_CAPABILITIES,
  weeklySpotlight,
};
