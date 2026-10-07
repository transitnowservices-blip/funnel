# $1/Day Trial — Email Copy REVIEW (DRAFT)

**Status: DRAFT — Davena must approve every email below before anything goes live.**
Nothing here sends today. The new sequences are wired into the funnel but
**disabled** (`"trialSequencesEnabled": false` in `config/emails.json`).
To arm them after approval: flip that flag to `true`. The nurture revision
(email 8 below) applies to `config/emails.json` → `sequences.nurture[4]` on approval.

Trial links used in copy (Davena's live Stripe links — never change):
- 7 days $7: https://buy.stripe.com/3cIfZi9PffsYcYV6oZ0480s
- 14 days $14: https://buy.stripe.com/cNi14o8LbbcIgb73cN0480q
- 30 days $30: https://buy.stripe.com/3cI28se5va8E1gdbJj0480t
- Complete $100/mo: https://buy.stripe.com/4gM4gA3qR6Ws5wt4gR0480o

How the sequences behave (for reference):
- **Trial abandoned cart:** someone clicks a trial button but doesn't pay within 1 hour → 3 emails (1h, 24h, 72h). Stops the second they buy.
- **Trial expiry:** 3 days before trial ends → "finish strong"; 1 day before → "last day"; on expiry → paywall email to Complete $100/mo; 3 days after expiry → final nudge. Stops if they subscribe.
- No email in any sequence promises hiring, work, routes, loads, earnings, or income.

---

## 1. Trial abandoned cart — email 1 (1 hour after they leave)

**Subject:** Your $1/day trial is waiting

Hi {{first_name}},

You were about to start your $1/day trial and didn't finish — that happens.

Quick reminder of what $7 gets you: **7 days of full Complete access** — guided applications, follow-up coaching until they answer, the live hiring directory re-verified fresh for you, the certification and readiness checklist, and bid board access.

Your link is still good:

**[Start my trial — 7 days, $7](https://buy.stripe.com/3cIfZi9PffsYcYV6oZ0480s)**

Want more runway? [14 days for $14](https://buy.stripe.com/cNi14o8LbbcIgb73cN0480q) or [30 days for $30](https://buy.stripe.com/3cI28se5va8E1gdbJj0480t).

One-time payment. No subscription, no commitment.

— Davena, TransitNow

---

## 2. Trial abandoned cart — email 2 (24 hours)

**Subject:** What $1/day actually gets you

Hi {{first_name}},

Before you decide, here's exactly what's inside the trial:

- **Guided applications** — we walk your applications in right, not just thrown at a portal.
- **Follow-up coaching** — the day-3 call script, the day-7 check-in template, what to say when they go quiet.
- **The live hiring directory** — 150+ companies tracked, re-verified fresh for your vehicle and city when you join.
- **Certification & readiness checklist** — HIPAA course guidance, documents, insurance review.
- **Bid board access** — see what's moving while you're in.

That's the full Complete experience — the same thing members pay $100/month for — at $1 a day.

**[Start my trial — 7 days, $7](https://buy.stripe.com/3cIfZi9PffsYcYV6oZ0480s)**

No guaranteed hires — anyone who promises that is lying to you. What you get is the intel, the coaching, and the tools. The hire is yours to win.

— Davena, TransitNow

---

## 3. Trial abandoned cart — email 3 (72 hours, last call)

**Subject:** Last call on your $1/day trial

Hi {{first_name}},

Last note about your trial — no pressure.

If getting hired as a driver would change things for you, $7 is the cheapest way to see what we do: **[7 days for $7](https://buy.stripe.com/3cIfZi9PffsYcYV6oZ0480s)**.

If the timing isn't right, that's fine. We won't keep nudging you about this.

— Davena, TransitNow

---

## 4. Trial expiry — 3 days before trial ends

**Subject:** {{trial_days_left}} days left on your trial — finish strong

Hi {{first_name}},

You've got **{{trial_days_left}} days left** on your $1/day trial (ends {{trial_end_date}}).

Here's what to finish before it runs out:

- Get every application in — don't leave one sitting half-done.
- Run the follow-up on anything you already applied to — day-3 call, day-7 check-in.
- If a company told you no, use the "why wasn't I picked" script — a no educates you.

When your days run out, keep everything moving with Complete at $100/month — same full access, no starting over: **[Continue with Complete](https://buy.stripe.com/4gM4gA3qR6Ws5wt4gR0480o)**

— Davena, TransitNow

---

## 5. Trial expiry — 1 day before trial ends

**Subject:** Tomorrow your trial ends

Hi {{first_name}},

Tomorrow ({{trial_end_date}}) your trial days run out.

If you're mid-application with any company, get the follow-up in today — that's the part most drivers skip, and it's the part that gets people hired.

Want to keep going without missing a beat? **[Continue with Complete — $100/month](https://buy.stripe.com/4gM4gA3qR6Ws5wt4gR0480o)**. Everything stays exactly where it is.

— Davena, TransitNow

---

## 6. Trial expiry — on expiry day (paywall email)

**Subject:** Your trial ended — here's how to keep going

Hi {{first_name}},

Your $1/day trial has ended. To keep your profile moving with these companies — guided applications, follow-up coaching, the live hiring directory, and bid access — continue with Complete:

**[Continue with Complete — $100/month](https://buy.stripe.com/4gM4gA3qR6Ws5wt4gR0480o)**

Monthly subscription, cancel anytime. No guaranteed hires — just the intel, the coaching, and the tools that keep you in front of companies instead of in a pile.

— Davena, TransitNow

---

## 7. Trial expiry — 3 days after expiry (final nudge)

**Subject:** Still thinking about it?

Hi {{first_name}},

Your trial ended a few days ago. If you're still thinking about it, the door's open: **[Complete — $100/month](https://buy.stripe.com/4gM4gA3qR6Ws5wt4gR0480o)**.

And if the timing isn't right, that's fine too. You know where to find me.

— Davena, TransitNow

---

## 8. Nurture email 5 revision — trial as the first call-to-action (DRAFT)

Replaces the offer step of the existing 5-step nurture (`sequences.nurture[4]`,
subject stays "Wrapping up the week: your next step"). Currently live with the
$50/$100-only pitch — **do not apply until Davena approves.**

**Subject:** Wrapping up the week: your next step

Hi {{first_name}},

Quick recap of this week:

- You picked up the **Medical Courier Readiness Checklist**
- We talked about why applications go nowhere — and why follow-up is the skill that gets drivers hired
- We showed you the follow-up system: scripts, templates, and the "why wasn't I picked" script
- We were honest about who this fits — and who it doesn't

If you're ready, start with the $1/day trial — **full Complete access** for 7, 14, or 30 days. Guided applications, follow-up coaching, the live hiring directory, bid board. One-time payment, no subscription:

**[7 days — $7](https://buy.stripe.com/3cIfZi9PffsYcYV6oZ0480s) · [14 days — $14](https://buy.stripe.com/cNi14o8LbbcIgb73cN0480q) · [30 days — $30](https://buy.stripe.com/3cI28se5va8E1gdbJj0480t)**

When your days run out, continue with Complete at $100/month if you want to keep going.

Prefer to go straight in? **Basic — $50/month:** the live hiring list (150+ companies, re-verified when you join), certification and readiness checklist, application and paperwork coaching. **Complete — $100/month:** everything in Basic, plus follow-up training from day one, the full toolkit, resume adjustments, the "why wasn't I picked" script, and the drivers-only community.

Monthly subscription. Cancel anytime. We teach, we coach, we give you the tools — the hire is yours to win.

Questions? Reply to this email or call {{business_phone}}.

— TransitNow

---

## Approval checklist

- [ ] Emails 1–3 (trial abandoned cart)
- [ ] Emails 4–7 (trial expiry series)
- [ ] Email 8 (nurture offer-step revision)
- [ ] Flip `trialSequencesEnabled` to `true` in `config/emails.json`
- [ ] Apply email 8 to `config/emails.json` → `sequences.nurture[4]`
