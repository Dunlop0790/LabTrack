# LabTrack

A lightweight, real-time issue tracking board for clinical lab automation teams. Built to coordinate equipment issues between Automated Line Operators (ALOs), on-site leads, and Siemens Healthineers field engineers.

## Background

In a high-volume clinical laboratory, instrument errors and track issues happen constantly — and sometimes simultaneously. Communication typically flows through walkie-talkies or face-to-face conversations, which works for isolated problems but breaks down when:

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
- **Instrument tagging** with predefined types (HVS, ROM400, BIM, IOM, BOM, CM, DSM, DCM, SM, WBB, ADV, ASH, BASH, USH, etc.) and unit numbers
- **Comment threads** on each issue with timestamp, author, and role
- **Self-claim** to assign yourself with one click
- **Browser push notifications** for Critical and Urgent issues
- **Multiple boards** for separate teams or workflows
- **No login required** — user name and role are saved to the local browser

## Tech stack

- HTML, CSS, and JavaScript (single file, no build step)
- Firebase Firestore for real-time database
- GitHub Pages for hosting

## Setup

To deploy your own instance:

1. Create a free [Firebase](https://firebase.google.com) project
2. Enable Firestore Database in test mode
3. Register a web app and copy the `firebaseConfig` object
4. In `index.html`, replace the existing `firebaseConfig` block with your own
5. Push the file to a GitHub repository and enable GitHub Pages

## Roadmap

- Firestore security rules (currently open in test mode)
- Issue history and audit log
- Keyword search across issues
- Mobile-optimized layout

## License

MIT
