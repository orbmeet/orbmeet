# Orb Meet glossary

Read this before changing anything about Spaces, meetings or boards. Each term
has one meaning, used the same way in tables, types, API fields and UI text.

> **A Space is a place. A meeting is that place while people are in it.**
>
> **While a meeting is happening, the meeting decides.
> The rest of the time, the Space decides.**

Where the code still works the old way, the entry says so under *Today*. Those
notes are removed as the code catches up.

## Places and people

**Space** — A place that holds boards, files and past meetings, and has one
meeting link. Shared or personal.

**Personal Space** — The Space every account has. Its owner is its only member.
*Today:* hidden in the UI.

**Payer** — Who a Space's usage is billed to: a user or an Organization
(`spaces.owner_user_id` XOR `spaces.organization_id`).

**Organization** — A payer with seats. A seat makes a person eligible to join
the Organization's Spaces; it grants no access by itself. Organization owners
and admins govern billing and may delete the Organization's Spaces, but they
see a Space's content only if they are its members.

**Owner** — The one person who governs a user-paid Space, stored once, on the
Space (`spaces.owner_user_id`). Their membership is an ordinary `admin` one.
Organization-paid Spaces have no owner, only admins.

**Admin** — Manages a Space: members, settings, past meetings.

**Member** — Belongs to a Space: sees and edits its content, joins its meetings.

**Guest** — Someone in a personal Space's meeting without an account. A kind of
person, never a role.

## Meetings

**Meeting link** — A Space's permanent address (`orbmeet.com/abc-defg-hij`). One
per Space, rotatable. *Today:* rows in `meeting_links`.

**One-time link** — Lets one person into a personal Space's meeting once. Shared
Spaces have none. *Today:* each one starts a meeting of its own.

**Invite** — An invitation to join a Space as a member (`space_invites`). Never
used for meeting entry.

**Meeting** — One stretch of a Space being live, from the first person in to the
last person out. At most one per Space at a time. *Today:* personal Spaces can
have several.

**Scheduled meeting** — A plan with a time, title, organizer and attendees. A
meeting claims at most one. In a shared Space, the meeting live during its
window claims it. In a personal Space, a running meeting never claims the next
one; its attendees wait until the owner admits them or ends the current meeting.

**Host** — Runs a live meeting from a seat in it: admits, removes, records,
ends, grants co-host. Owner and admins are hosts; from outside the meeting they
may only end or rename it.

**Stand-in host** — While no owner or admin is in the meeting, the organizer if
they are in it, else the starter if they are, acts as host. Always a current
member, let in as a host would be. The role hands back when an owner or admin
takes a seat, and ends when the stand-in leaves.

**Co-host** — Someone a host trusted for this meeting. *Today:* called
"moderator" in code and most UI.

**Participant** — Everyone else in the meeting. *Today:* `attendee` in code.

**Attended** — Connected to the meeting at least once. Being approved is not
attending.

**Meeting event** — One entry in a meeting's append-only log. *Today:* not yet
recorded.

## Boards and outputs

**Board** — A whiteboard. Lives in exactly one Space.

**Presentation** — A board being shown in a live meeting. Holds the presenter,
spotlight, lock and edit grants, and ends with the meeting. *Today:* the
presenter's page is the board's navigation record, synced with the board's
document; who may present is kept in the board's own database.

**Lock** — While on, only hosts, co-hosts and people granted edit can change a
presented board, from any tab. *Today:* there is no lock; meeting participants
are view-only by default, and members can still edit from the Space page.

**Copy** — A new, independent board in another Space: the only way content
crosses a Space boundary, allowed when the source Space allows copying out.

**Version** — A saved state of a board, listed in its History.

**Restore point** — The version saved automatically just before a restore.
*Today:* revision kind `pre_restore`.

**Meeting capture** — The version a past meeting points to: what the board
looked like when it stopped being shown. *Today:* revision kind `meeting_end`.

**Backup** — A sync node's copy of a board's live database in storage. Internal;
never shown to people.

**Captions** — Live speech-to-text on screen. Never stored.

**Transcript** — Stored speech-to-text of a meeting.

**Summary** — An AI-written overview of a transcript.

**Recording** — A stored video of a meeting.

## Rules that are easy to get wrong

- **Past meetings belong to the Space.** A shared Space's past meetings are
  visible to its current members; leaving or removal ends access. A personal
  Space's past meetings are visible to its owner and to every signed-in person
  who attended.
- **Meeting defaults come from the Space,** never from whoever opened it.
- **After a meeting ends there is no host.** Managing a past meeting is an admin
  action in its Space.
- **No time-based retention.** Storage is limited by size, per payer.
- **One decider each.** The meeting's coordinator decides live authority; Space
  capability decides everything at rest. Nothing else re-derives either.
