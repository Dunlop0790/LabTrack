# LabTrack

Internal operational tool for the Automated Line team at DaVita DeBary.
Built and maintained by Corey Hausterman.

---

## What it does

LabTrack consolidates several day-to-day operational workflows into a single
browser-based tool accessible to ALOs, Leads, and Siemens Healthineers staff.

**Issue Board**
A real-time Kanban-style board for logging and tracking instrument and track
issues across Optimus Prime (OP) and Bumblebee (BB). Issues move through
four status lanes: Open, In Progress, Monitoring, and Resolved. Supports
priority levels, instrument tagging, assignee tracking, comment threads,
activity history, @mentions, and sound alerts for Critical/Urgent issues.

**Reports**
A structured form builder for the two recurring shift reports:
- Line Status (sent every 2 hours at the :30 mark) — processes FlexLab
  CSV exports into a formatted hourly summary table, plus all supporting
  fields (BIM read rates, OOS analyzers, overloads, startup times, etc.)
- EOD Report — mirrors the Automated Line EOD Report template with all
  checkboxes, dropdowns, and text fields. Both reports copy directly into
  Outlook web with formatting preserved.

**Archive**
Resolved issues are automatically archived every Sunday at 6am EST and
permanently purged after 90 days. The archive viewer allows browsing and
searching past issues by week and board.

**Stats**
A dashboard showing issue volume, most problematic instruments, average
resolution time, and recurring problems across a selectable date range.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Single-file HTML/CSS/JavaScript (no build step) |
| Database | Google Firebase Firestore (Spark free tier) |
| Hosting | GitHub Pages |
| CSV processing | PapaParse (CDN) |

---

## Cloud provider

The app uses **Google Firebase Firestore** as its database. All connection
credentials and a full list of database operations used are documented in
a clearly labeled block at the top of the script inside `index.html`.

### Transferring the Firebase project

Firebase supports direct project ownership transfer. The new owner receives
full control of the database, rules, and configuration. The app URL and
project ID remain unchanged — no code edits required.

Steps: Firebase console > Project Settings > your account > Transfer project.

### Migrating to a different cloud provider

All database calls are made through the Firebase Firestore SDK and are
catalogued in the Database Layer comment block inside `index.html`. The
block lists every collection, every operation type used (create, update,
delete, real-time subscription, etc.), and notes which parts of the app
each collection serves.

To migrate: replace the Firebase initialization and SDK calls in that block
with equivalent calls for the new provider. No other part of the app changes.

---

## Security

**Firestore rules (v1.0)**

Rules are managed in the Firebase console under Firestore Database > Rules.
Current status: validated collections with field-level write constraints.
No authentication layer — reads are open to anyone with the URL.

Current rules enforce:
- Only permitted collections can be read or written (catch-all deny at bottom)
- Write operations validate required fields and data types
- Comment and history records are immutable after creation
- Roster entries must use a valid role (ALO, Lead, Siemens)
- Snapshot records cannot be edited after saving

**Known limitation / next step**

Without user authentication, the rules cannot restrict access by identity.
Anyone with the URL can read all data and write within the permitted rules.
Adding Firebase Authentication (Google sign-in or email link) would allow
rules to be tightened to `request.auth != null`, restricting access to
verified users only. This is the documented next step for security hardening.

---

## Data stored

No patient data, no PHI, no sample results, no MRNs. The database contains:
- Instrument issue titles and descriptions (operational, not clinical)
- Team member first names and roles
- Line Status and EOD report drafts
- Internal maintenance timestamps

---

*Made by Corey Hausterman*
