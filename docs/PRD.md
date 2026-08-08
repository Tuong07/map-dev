# What we're building

Indoor wayfinding for UMass Boston. Google Maps, but for the inside of Wheatley Hall.

## The problem

Wheatley is a maze. Finding a specific room means wandering, reading inconsistent
signage, or asking a stranger. Google Maps stops at the front door — it has no idea
what's inside a building.

## Who it's for

A student who is late, standing in a hallway, holding a phone, who needs one room,
once. That framing decides almost every design question:

- **Zero install.** They will not visit the App Store to find a classroom. A link
  has to work immediately. This is why the app is a website.
- **Zero login.** No accounts, no email, no onboarding.
- **Fast.** Type a room number, see the way. Anything else is in the way.

## MVP scope

One floor of Wheatley Hall, working end to end.

| Feature | Why |
|---|---|
| Search by room number | The only thing anyone actually looks up |
| Floor plan with the room highlighted | Answers "where is it" |
| Route from a chosen start | Answers "how do I get there" |
| Written turn-by-turn | "Continue 24 m, then turn left" |
| Live position dot | The interesting part — **conditional on Phase 0 Test 5** |

## Explicit non-goals

Not "later" — **not in the MVP**, deliberately:

- Second floor and beyond. One floor working completely beats two half-done.
- Other buildings. Wheatley only. Walking between buildings is Google Maps' job.
- Elevators and accessible routing. Stairs only. The data model has room for it.
- Search by person, department, or course number.
- AR. See [AR.md](AR.md) — it's designed, it's cheap, it's still Phase 2.
- 3D exploded floor view. Cut. Adds no utility.
- Sharing links, offline mode, dark mode, accounts.

## Definition of done

Someone who has never seen the app can, from a link:

1. Type a room number and find it
2. Get a route from a building entrance
3. Follow written directions to the room
4. Have it work on their own phone, no install

If Test 5 passes, add: watch a position dot track them as they walk.

## Deadline

Before September 2026. Capacity is 2–3 hrs/day. Roughly 60 working hours.

Cut order if it slips: **blue dot** first (leaving a searchable map with written
directions, still useful), then turn-by-turn (leaving a searchable map).

## Why this project exists

Resume piece and a passion project. That means the code has to be explainable, not
just working — see [../CLAUDE.md](../CLAUDE.md). A repo that can't be walked through
in an interview has failed regardless of whether it runs.
