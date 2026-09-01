# National Gear Exchange Information Architecture

Date: 2026-08-31
Applies to: closed Flarum pilot

## Purpose

Provide one National PHW space where eligible programs can request and offer fly-fishing, fly-tying, rod-building, and related gear. Listings are visible across eligible programs to improve matching and reduce unused equipment.

## Forum Areas

| Area | Audience | Purpose |
| --- | --- | --- |
| Gear Exchange | `phw-members` | ISO and Available listings and replies |
| Announcements and How It Works | `phw-members` | Read-only policy, help, and pilot updates |
| Moderator Operations | `exchange-moderators`, `exchange-admins` | Private workflow, escalation, and decisions |

## Tag Model

Use Flarum tags rather than a forum per state or program.

| Tag family | Tags | Rule |
| --- | --- | --- |
| Listing type | `iso`, `available` | Exactly one required |
| Activity | `fly-fishing`, `fly-tying`, `rod-building`, `other` | At least one required |
| Lifecycle | `open`, `pending-transfer`, `fulfilled` | Exactly one; moderators may correct |
| Origin | `program-<slug>` | Applied from verified member context or selected from a controlled list |

Program tags identify a listing's source and routing contact. They never prevent another eligible PHW program from reading or responding.

## Listing Template

Configure the selected template/form capability to request the following fields. The title must name the item and intent, for example `ISO: Fly-tying vises for Harrisburg program`.

```text
Listing type: ISO / Available
Item and description:
Condition: New / Excellent / Good / Fair / Parts or repair
Quantity:
Program:
City and state:
Pickup, shipping, or both:
Who covers shipping, if any:
Needed by / available from:
Photos or attachment, when useful:
```

Members coordinate through replies or private messages. Do not place a personal address, personal phone number, participant details, medical information, or other sensitive data in a public listing.

## Lifecycle

1. Member creates a listing with `open` status.
2. During the pilot, a moderator approves it before broad visibility.
3. When participants are coordinating a transfer, author or moderator applies `pending-transfer`.
4. When complete, author or moderator applies `fulfilled`, closes replies when appropriate, and retains the discussion as a searchable record.
5. Moderators review stale `open` listings at the documented interval and ask for an update, close, or archive them.

## Content Rules

Allowed:

- Equipment and supplies that support PHW fly-fishing, fly-tying, rod-building, and related program activities
- Requests, offers, condition questions, and transfer coordination
- Photos and documents relevant to the exchange

Not allowed:

- Payments, auctions, sales, escrow, fundraising, or external payment requests
- Commercial advertising or non-PHW transactions
- Weapons, regulated goods, controlled substances, or unsafe/illegal materials
- Personal addresses, personal phone numbers, participant medical information, or protected member records
- Harassment, discrimination, threats, spam, or misleading item descriptions

## Permissions

| Group | View | Create listings | Reply | Moderate | Administer |
| --- | --- | --- | --- | --- | --- |
| Anonymous | No | No | No | No | No |
| `phw-members` | Yes | Yes | Yes | No | No |
| `exchange-moderators` | Yes | Yes | Yes | Approved actions only | No |
| `exchange-admins` | Yes | Yes | Yes | Yes | Yes |

Exact permission names and scope must be verified on the pinned Flarum release. Do not infer staff access from PHW tenant roles.

## Notification Policy

Start conservatively. Members may follow activity tags or their program tag. Use forum email preferences and transactional SMTP; do not duplicate board events into Alpine Events email or SMS workflows. Verify mail authentication, unsubscribe/preference behavior, bounce handling, and rate limits before pilot invitations.

## Success Measures

- Number of active programs and members
- Listing approval time
- Open-to-fulfilled rate
- Median age of open listings
- Flag rate and moderation time
- Email bounce/suppression rate
- Identity denial/error rate
- Accessibility and support defects