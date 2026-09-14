# AI Instructions: Build a Training PowerPoint for The Current

## Assignment

Create a polished, accessible training PowerPoint that teaches Project Healing Waters members, event creators, and administrators how to use **The Current**, the event scheduling and participation application.

Use `docs/the-current-user-guide.md` as the authoritative content source. Do not invent screens, controls, policies, scores, permissions, URLs, or workflows. When source material is incomplete, add a clearly marked presenter note requesting confirmation instead of guessing.

Content baseline: `docs/the-current-user-guide.md`, version September 13, 2026. Recheck the deployed application immediately before capturing screenshots; do not reuse screenshots that predate multi-program selection or session-recovery changes.

## Deliverables

Produce:

1. An editable `.pptx` file in 16:9 widescreen format.
2. A PDF export suitable for email and printing.
3. Speaker notes for every instructional slide.
4. A separate list of screenshots still needed, including the page, viewport, and UI state to capture.
5. Alt text for every meaningful image or screenshot.

## Audience

The primary audience includes adult volunteers and participants with mixed technical comfort. Some viewers may use a screen reader, magnification, keyboard navigation, or a mobile device. Write in plain language and define abbreviations on first use.

## Learning objectives

By the end of training, learners should be able to:

- sign in and select the correct program;
- switch programs, recover an expired session, and sign out safely;
- manage notification preferences;
- find an event and submit or change an RSVP;
- understand Volunteer and Participant roles;
- create and manage an event when authorized;
- assign members and record attendance;
- explain CY/PY attendance and the priority score; and
- know where to get help.

## Required slide sequence

Create 15 slides in this order:

1. **The Current**
   Subtitle: Project Healing Waters event scheduling and participation. Include audience and session purpose.

2. **What You Can Do**
   Summarize events, RSVP, calendar, notifications, assignments, attendance, reports, and Take a Vet Fishing.

3. **Roles and Access**
   Compare Member, Event Creator, Administrator, and TAVF Creator. State that menus vary by permission.

4. **First Sign-In**
   Show invitation link, Google or email one-time code, matching the invited email, and program selection.

5. **Programs, Sessions, and Sign-Out**
   Explain that only active programs appear, show the **Current program** selector and scope bar for a multi-program account, and tell learners to verify the program name before making changes. Explain that the page reloads when the program changes. Cover **Your session has expired** → **Back to sign in**, temporary account-load errors → **Try again**, **No Tenant Access** → contact the program administrator, and **Sign out** for shared computers.

6. **Dashboard and Navigation**
   Explain Dashboard, Preferences, Events, Calendar, and role-dependent menu items.

7. **Find and RSVP to an Event**
   Show both signed-in and invitation-link workflows. Include role selection before Yes, Maybe, or Waitlist.

8. **Notification Preferences**
   Cover mobile number, channel preference, SMS consent, Save, STOP, and HELP.

9. **Create and Publish an Event**
   For Event Creators and Administrators. Cover event categories, core details, lead, scheduler, capacity, audience, draft review, and publish caution. Categories are Fishing Trip, Fundraiser, Community Service, Training, Social, and Other.

10. **Manage Capacity and Guests**
   Explain Capacity Controls, Close Event At Capacity, Manual Association, Guest Assignments, and event-specific Volunteer Duty / Specialty values such as Cook or Driver.

11. **Use the RSVP Pool**
    Explain the two priority-role buttons, history columns, priority rank, assignment buttons, and human judgment.

12. **How CY/PY Is Calculated**
    Define current calendar year and previous calendar year. State that only attended assignments on completed events count, totals are deduplicated by event, and Lead plus Participant earns `0.5` participant credit.

13. **How Priority Is Calculated**
   Show this formula exactly:
   `Participant score = role CY + (role PY × 0.6) + (total CY × 0.25) + (total PY × 0.1) − service CY − (service PY × 0.5) + RSVP adjustment`
   Show Yes `-0.2`, Maybe `0`, Waitlist `+0.2`. State that lower scores rank first and that the service deduction applies only to Participant priority. Include the `#1 (-0.2)` zero-history Yes example and the three-service-event `-2.45` example.

14. **Record Attendance and Finish the Event**
    Demonstrate checking Attended, changing the event to completed, and sending or downloading post-event summaries. Emphasize that history does not update until the event is completed.

15. **Troubleshooting and Help**
   Include the score checklist, the distinction between session expiry, temporary account-load failure, and no active program access, the support contact location, and what details to include in a help request. Never ask for a password, one-time code, sign-in link, or access token.

## Visual direction

- Treat **The Current** as the product name and **Project Healing Waters** as the organization.
- Use an outdoors-informed but restrained visual system: river green, white, charcoal, and one warm accent. Avoid decorative gradients and generic technology imagery.
- Use the official Project Healing Waters logo only from approved project assets and preserve its aspect ratio and clear space.
- Prefer real screenshots of The Current over illustrations.
- Keep screenshots large enough to read. Crop to the relevant control and add simple numbered callouts outside the interface.
- Never fabricate a screenshot or alter data in a way that could be mistaken for a real member record.
- Use fictional names and masked contact details in training captures.
- Use one concept per slide. Keep body copy brief and move detail into speaker notes.
- Do not put paragraphs over screenshots.

## Accessibility requirements

- Minimum 28 pt body text and 36 pt slide titles.
- High color contrast meeting WCAG AA where practical.
- No reliance on color alone; pair status color with text or an icon.
- Logical reading order and meaningful slide titles.
- Alt text for screenshots, logos, and informational graphics.
- Closed-caption-ready speaker notes with acronyms expanded.
- Avoid dense tables. When a table is necessary, use a header row and no merged cells.
- Provide the full score formula as text, not only as an image.

## Screenshot plan

Request or capture these application states at desktop width and, for RSVP, mobile width:

- Sign-in page branded **The Current**.
- Program selector, using demo or fictional program data.
- Header with the **Current program** selector and scope bar, using an account with at least two synthetic program memberships.
- Session-expired recovery screen and temporary account-load error screen.
- Dashboard with upcoming events and My RSVPs.
- Notification Preferences with SMS consent unchecked and no real phone number.
- Events list and event form in draft state.
- Public RSVP page with Volunteer/Participant choices.
- Event management overview and capacity controls.
- RSVP Pool showing CY/PY and Priority columns.
- Current Assignments with Attended control.
- Reports or post-event download actions.

Before capture, remove or mask real names, email addresses, phone numbers, tokens, tenant identifiers, and private event details.

Use the Demo tenant or a synthetic staging tenant for authenticated screenshots. Do not use Colorado Springs screenshots while that tenant is suspended, and do not reactivate it merely to produce training material.

## Speaker-note requirements

For each slide, include:

- a 45–90 second narration;
- the action the learner should take;
- one likely question and its answer; and
- a transition to the next slide.

For slides 12 and 13, explicitly explain why a member with no history and a Yes RSVP can show `-0.2`, and why a checked attendance box does not count while an event remains draft or published.

## Quality checks before delivery

Confirm all of the following:

- Every product reference says **The Current**.
- The deck contains exactly 15 slides in the required sequence.
- Sign-in screenshots and labels match the current production page, including **Sign in**, **Sign in with Google**, and email OTP **Create one** guidance.
- Program-selection guidance states that only active programs appear and that **Current program** changes the current program context and reloads page data.
- Session-expired, temporary account-load, and no-active-access states are described as different conditions with the correct next action.
- Project Healing Waters is not renamed as an organization.
- Internal database term `MENTOR` is never shown to learners; use **Volunteer**.
- CY and PY are defined as calendar years, not rolling 12-month periods.
- The score formula and RSVP adjustments match the user guide exactly.
- Completed attended Volunteer assignments, including non-fishing events, are shown as service credit for Participant priority.
- Lower score is described as higher priority.
- Attendance requires both an attended assignment and a completed event.
- No real personal information appears.
- All images have alt text and all slides have speaker notes.
- The deck can be understood without a live application demonstration.

## Final response format

Along with the `.pptx` and PDF, provide a concise production report containing:

- slide count;
- source files used;
- screenshots used and screenshots still needed;
- accessibility checks performed;
- assumptions or unresolved questions; and
- any content intentionally omitted because it could not be verified.
