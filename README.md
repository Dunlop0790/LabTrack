# LabTrack

A lightweight, real-time issue tracking board for clinical lab automation teams. Built to coordinate equipment issues between Automated Line Operators (ALOs), on-site leads, and Siemens Healthineers field engineers.

## Background

In a high-volume clinical laboratory, instrument errors and track issues happen constantly. Communication typically flows through walkie-talkies or face-to-face conversations, which works for isolated problems but breaks down when:

- Multiple issues are happening at once
- An issue needs long-term monitoring after a fix
- A teammate on the next shift needs context on what's already been tried
- Leadership wants visibility into what's currently broken

LabTrack provides the entire team a shared, browser-based board to log issues, claim ownership, and post updates as resolution progresses.

## Features

- **Real-time sync** across all users via Firebase Firestore
- **Four status lanes**: Open → In Progress → Monitoring → Resolved
- **Priority levels** (Critical, Urgent, Monitor, Low) with automatic sorting
- **Track tagging** for OP (Optimus Prime) and BB (Bumblebee), color-coded
- **Instrument tagging** with predefined types and unit numbers
- **Comment threads** on each issue with timestamp, author, and role
- **Self-claim** to assign yourself with one click
- **Browser push notifications** for Critical and Urgent issues
- **Multiple boards** for separate teams or workflows
- **No login required** user name and role are saved to the local browser

## Tech stack

- HTML, CSS, and JavaScript (single file)
- Firebase Firestore for real-time database
- GitHub Pages for hosting

## Roadmap

- Firestore security rules (currently open in test mode)
- Issue history and audit log
- Keyword search across issues
- Mobile-optimized layout

## License

MIT
