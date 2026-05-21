// ═════════════════════════════════════════════════════════════════════════
// CLOUD PROVIDER CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────
// LabTrack currently uses Google Firebase (Firestore) as its cloud database.
// All connection credentials are in this block.
//
// TO TRANSFER TO A NEW FIREBASE PROJECT:
//   1. Go to console.firebase.google.com
//   2. Open the new project, register a web app
//   3. Copy the firebaseConfig object shown and paste it below, replacing
//      the existing one. No other changes needed.
//
// TO SWAP TO A DIFFERENT CLOUD PROVIDER (e.g. Azure Cosmos DB, AWS, etc.):
//   This block initializes Firebase and creates `db`, the database handle.
//   Every database operation in the app goes through `db` using the Firebase
//   Firestore SDK. To swap providers:
//     - Remove this block and the two Firebase <script> tags above
//     - Initialize your provider's SDK instead
//     - Replace the Database Layer functions (marked below in the script)
//       with equivalent calls for your provider
//     - The rest of the app (UI, state, logic) does not change
//
// SECURITY RULES:
//   Rules are managed separately in the Firebase console under
//   Firestore Database > Rules. A copy is maintained in the project README.
//   Status: v1.0: validated collections, no authentication layer yet.
//   Next step: add request.auth != null checks once auth is enabled.
// ═════════════════════════════════════════════════════════════════════════
firebase.initializeApp({
  apiKey:"AIzaSyCP9k-mZZGiRW94ZH9JopuURbVuw0MZro8",
  authDomain:"lab-tracking-928ec.firebaseapp.com",
  projectId:"lab-tracking-928ec",
  storageBucket:"lab-tracking-928ec.firebasestorage.app",
  messagingSenderId:"1076816645332",
  appId:"1:1076816645332:web:43ed9d11de3f0e3c94ff41"
});
const db = firebase.firestore();
// ─────────────────────────────────────────────────────────────────────────
// DATABASE LAYER
// All Firestore operations used by this app are listed below.
// If migrating to another provider, these are the calls to replace.
// Each is a thin wrapper around the Firestore SDK: no business logic here.
//
//   Collections used:
//     boards         : board metadata (title, createdAt)
//     issues         : issue cards with subcollections: comments, history
//     archive        : resolved issues moved weekly, with subcollections
//     roster         : team member names and roles
//     meta           : internal maintenance timestamps
//     lsSnapshots    : saved Line Status and EOD report drafts
//     lsArchive      : permanent final Line Status records (one per day, keyed YYYY-MM-DD with 05:30 EST day rollover)
//
//   Operation types used:
//     .collection(name).add(data)            : create document
//     .collection(name).doc(id).update(data) : update document
//     .collection(name).doc(id).delete()     : delete document
//     .collection(name).doc(id).get()        : read single document
//     .collection(name).get()                : read entire collection
//     .collection(name).where(f,op,v).get()  : filtered read (one-time)
//     .collection(name).where(f,op,v)
//       .onSnapshot(callback)                : real-time subscription
//     .collectionGroup(name).where(...)
//       .onSnapshot(callback)                : cross-collection subscription
//     FieldValue.serverTimestamp()           : server-generated timestamp
//     FieldValue.increment(n)                : atomic counter increment
//     batch.set() / batch.commit()           : batched multi-document write
// ─────────────────────────────────────────────────────────────────────────

// ── STATE ─────────────────────────────────────────────────────
// Module-level state shared across the entire application. These are
// reassigned (rather than re-declared) as the app navigates between
// boards, opens detail views, and receives realtime updates from
// Firestore. Subscription handles (issueSub, detailSub, historySub) are
// retained so they can be cleaned up on context switch to prevent
// duplicate listeners and memory leaks.
let user = null, selectedRole = null;
let boardId = null, boards = [];
let issues = [], issueSub = null;
let detailSub = null, historySub = null;
let tFilter = 'all', pFilter = 'all', searchTerm = '';
let soundEnabled = localStorage.getItem('lt_sound')!=='off';
let godzillaMode = localStorage.getItem('lt_godzilla')==='on';
let isFirstLoad = true;
let mentionState = {textareaId:null, listId:null, startPos:0, term:''};
const COLS = ['open','inprogress','monitoring','resolved'];
const COL_LABELS = {open:'Open',inprogress:'In Progress',monitoring:'Monitoring',resolved:'Resolved'};
const PRIORITY_ORDER = {critical:0,urgent:1,moderate:2,low:3};
const PRIORITY_LABELS = {critical:'Critical',urgent:'Urgent',moderate:'Moderate',low:'Low'};
// Aging thresholds in milliseconds. If Critical sits Open >1hr, show warning
const AGE_WARN_MS = {critical:60*60*1000, urgent:2*60*60*1000, moderate:24*60*60*1000, low:7*24*60*60*1000};

// Seeded roster. These names get added on first launch if not already present
const SEED_ROSTER = {
  ALO: ['Corey','Matt','Bruce','Jorge','Lyza','Daisy','Katie','Melanie','Grace'],
  Siemens: ['Angel','Johnny','Malachi','Alvin','Greg','Malek','Deanna','Mitch','Eric','Steve','Santiago','Ryan','Kevin','Dan'],
  Lead: ['Zack','Victoria','Veronica','Amanda','Ashley','Nichole','Morgan']
};
const ROLE_ORDER = ['Lead','ALO','Siemens'];
const ROLE_LABELS = {ALO:'ALOs', Siemens:'Siemens', Lead:'Leads'};
let roster = []; // [{name, role}]

// Reaction options on comments
const REACTIONS = [
  {key:'ack', emoji:'👍', label:'Acknowledged'},
  {key:'looking', emoji:'👀', label:'Looking into it'},
  {key:'done', emoji:'✅', label:'Done'}
];

// ── HELPERS ───────────────────────────────────────────────────
// Generic utility functions used throughout the app. Includes HTML
// escaping (esc), short-id generation for client-side keys, time
// formatting, toast notifications, and DOM helpers. None of these
// touch Firestore or hold app state; they are safe to call from any
// context.
const esc = s => s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600)}
function initials(name){return name?name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase():'?'}
function fmtTime(ts){if(!ts?.toDate) return 'just now';const d=ts.toDate();return d.toLocaleDateString()+" "+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}

// Format duration from a timestamp until now (e.g. "2h 14m", "3d 4h")
function fmtAge(ts){
  if(!ts?.toDate) return '';
  const ms = Date.now() - ts.toDate().getTime();
  if(ms < 60000) return 'just now';
  const mins = Math.floor(ms/60000);
  if(mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins/60);
  if(hrs < 24) return `${hrs}h ${mins%60}m`;
  const days = Math.floor(hrs/24);
  return `${days}d ${hrs%24}h`;
}

// Check if an issue is "aging" (sat too long without progress)
function isAging(issue){
  if(issue.status==='resolved') return false;
  if(!issue.createdAt?.toDate) return false;
  const age = Date.now() - issue.createdAt.toDate().getTime();
  return age > (AGE_WARN_MS[issue.priority]||AGE_WARN_MS.low);
}

// ── TOOLTIP HELPER ────────────────────────────────────────────
// Generates the HTML for a tooltip trigger bubble and its content box.
// Usage: tt('Your explanation text here') inside any label or heading.
// The bubble shows on hover (desktop) and toggles on tap (mobile).
// text: plain string, no HTML markup. Flip: set true to open downward
// when the trigger is near the top of the viewport.
function tt(text, flip){
  const safeText = esc(text);
  return `<span class="tt-wrap${flip?' tt-flip':''}"><button class="tt-btn" type="button" onclick="ttToggle(event)" aria-label="More information">?</button><span class="tt-box">${safeText}</span></span>`;
}

// Tap-toggle for mobile: clicking the ? button opens/closes the tooltip.
// Clicking anywhere else on the page closes all open tooltips.
function ttToggle(e){
  e.stopPropagation();
  const btn = e.currentTarget;
  const wasOpen = btn.classList.contains('open');
  document.querySelectorAll('.tt-btn.open').forEach(b => b.classList.remove('open'));
  if(!wasOpen) btn.classList.add('open');
}
document.addEventListener('click', () => {
  document.querySelectorAll('.tt-btn.open').forEach(b => b.classList.remove('open'));
});

// ── ICONS ─────────────────────────────────────────────────────
// Inline SVG icon set used throughout the UI. All icons use
// stroke="currentColor" and fill="none" so they automatically inherit
// the text color of their parent element. This means the same icon
// definition works correctly in both light and dark mode and on
// colored backgrounds (header navy, toast white, etc.) without any
// per-theme overrides.
//
// Icons are 16x16 by default (stroke-width:1.75) for body-text contexts;
// override with inline style="width:Npx;height:Npx" where larger sizes
// are needed (e.g. setup screen, empty states). Style was chosen to
// match the Lucide icon library aesthetic: rounded line caps, balanced
// negative space, single-stroke construction.
const ICONS = {
  // Sun: theme toggle when in dark mode (click to switch to light)
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  // Moon: theme toggle when in light mode (click to switch to dark)
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  // Volume on: alert sounds enabled
  volumeOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  // Volume off: alert sounds muted
  volumeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>',
  // Hamburger menu (mobile navigation drawer trigger)
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  // Calendar with dot: Today panel (live shared report viewer)
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/></svg>',
  // Clipboard: Reports panel (Line Status and EOD forms)
  clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>',
  // Archive box: Archive panel (resolved issues by week)
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  // Bar chart: Stats panel (rollup metrics dashboard)
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="3" y1="20" x2="21" y2="20"/></svg>',
  // Printer: print current board view
  printer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  // Magnifying glass: search input (top of filter bar)
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  // Speech bubble: comment count badge on issue cards
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  // Triangle warning: aging card glow indicator
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  // Empty inbox: shown in Today panel when no report has been published
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="42" height="42"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  // Microscope: setup overlay welcome icon (LabTrack identity)
  microscope: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="48" height="48"><path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/></svg>',
  // Plus / new: used in hamburger menu items for "New Board"
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  // X / close / delete: used in hamburger menu for "Delete Board"
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  // Bell: in-app mention notification (replaces 💬 in browser notification body)
  // Chain link: external links in department dropdowns (FlexLab, DAS, etc.)
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
};

// Injects inline SVGs into all static placeholders that use the
// data-icon attribute. Runs once at app boot and any time new markup
// containing data-icon is added (e.g. when re-rendering panels).
// Searches for [data-icon=KEY] and replaces innerHTML with ICONS[KEY].
function injectStaticIcons(root){
  const scope = root || document;
  scope.querySelectorAll('[data-icon]').forEach(el => {
    const key = el.getAttribute('data-icon');
    if(ICONS[key]) el.innerHTML = ICONS[key];
  });
  // Inject tooltip bubbles into any element with a data-tooltip attribute.
  // The attribute value becomes the tooltip text; the bubble is appended
  // after the element's existing text content so labels read naturally.
  scope.querySelectorAll('[data-tooltip]').forEach(el => {
    // Skip if already injected (e.g. injectStaticIcons called twice)
    if(el.querySelector('.tt-wrap')) return;
    const text = el.getAttribute('data-tooltip');
    if(!text) return;
    const wrap = document.createElement('span');
    wrap.className = 'tt-wrap';
    wrap.innerHTML = `<button class="tt-btn" type="button" onclick="ttToggle(event)" aria-label="More information">?</button><span class="tt-box">${esc(text)}</span>`;
    el.appendChild(wrap);
  });
  const setupIco = scope.querySelector('#setupIcon');
  if(setupIco && !setupIco.innerHTML.trim()) setupIco.innerHTML = ICONS.microscope;
  const hamBtn = scope.querySelector('#hamburgerBtn');
  if(hamBtn && !hamBtn.innerHTML.trim()) hamBtn.innerHTML = ICONS.menu;
}

// ── SOUND ─────────────────────────────────────────────────────
// Web Audio API alert synthesis for high-priority issues. Uses a
// synthesized "ding-dong" for Critical/Urgent events and a low-frequency
// monster roar for Godzilla mode. The audio context starts suspended
// per browser autoplay policy and is unlocked on the first user click
// via unlockAudio(). User preference is persisted in localStorage.
let audioCtx = null;
let audioUnlocked = false;

function unlockAudio(){
  if(audioUnlocked) return;
  try {
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state === 'suspended') audioCtx.resume();
    // Play a silent buffer to fully unlock on iOS/Safari
    const buf = audioCtx.createBuffer(1,1,22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
    audioUnlocked = true;
  } catch(e){ console.warn('Audio unlock failed:',e) }
}

function playAlert(){
  if(!soundEnabled) return;
  if(!audioCtx) unlockAudio();
  if(!audioCtx) return;
  try {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    if(godzillaMode){
      playGodzillaRoar();
    } else {
      playDingDong();
    }
  } catch(e){console.warn('Sound failed:',e)}
}

// Standard two-tone alert
function playDingDong(){
  [880, 660].forEach((freq,i)=>{
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    const start = audioCtx.currentTime + i*0.18;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.25, start+0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start+0.25);
    osc.start(start);
    osc.stop(start+0.25);
  });
}

// Synthesized monster roar: layered low-freq sawtooth oscillators with frequency
// sweeps, plus filtered noise burst, to approximate a deep theatrical roar.
function playGodzillaRoar(){
  const ctx = audioCtx;
  const t0 = ctx.currentTime;
  const dur = 1.4;

  // Master gain to keep volume in check
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.001, t0);
  master.gain.exponentialRampToValueAtTime(0.5, t0+0.08);
  master.gain.setValueAtTime(0.5, t0+dur*0.7);
  master.gain.exponentialRampToValueAtTime(0.001, t0+dur);
  master.connect(ctx.destination);

  // Low growl oscillator with frequency sweep (60Hz -> 90Hz -> 50Hz)
  const o1 = ctx.createOscillator();
  o1.type = 'sawtooth';
  o1.frequency.setValueAtTime(60, t0);
  o1.frequency.linearRampToValueAtTime(95, t0+0.4);
  o1.frequency.linearRampToValueAtTime(70, t0+0.9);
  o1.frequency.linearRampToValueAtTime(45, t0+dur);
  const g1 = ctx.createGain();
  g1.gain.value = 0.7;
  o1.connect(g1).connect(master);

  // Mid harmonic for body
  const o2 = ctx.createOscillator();
  o2.type = 'square';
  o2.frequency.setValueAtTime(120, t0);
  o2.frequency.linearRampToValueAtTime(180, t0+0.4);
  o2.frequency.linearRampToValueAtTime(135, t0+0.9);
  o2.frequency.linearRampToValueAtTime(90, t0+dur);
  const g2 = ctx.createGain();
  g2.gain.value = 0.25;
  o2.connect(g2).connect(master);

  // Detuned third oscillator for grit
  const o3 = ctx.createOscillator();
  o3.type = 'sawtooth';
  o3.frequency.setValueAtTime(58, t0);
  o3.frequency.linearRampToValueAtTime(92, t0+0.4);
  o3.frequency.linearRampToValueAtTime(68, t0+0.9);
  o3.frequency.linearRampToValueAtTime(43, t0+dur);
  const g3 = ctx.createGain();
  g3.gain.value = 0.4;
  o3.connect(g3).connect(master);

  // Tremolo (rapid amplitude wobble) for a guttural quality
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 22;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.3;
  lfo.connect(lfoGain).connect(g1.gain);

  // Filtered noise burst layered on top for breath/grit texture
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate*dur, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for(let i=0;i<data.length;i++) data[i] = (Math.random()*2-1)*0.5;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 400;
  noiseFilter.Q.value = 5;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.001, t0);
  noiseGain.gain.exponentialRampToValueAtTime(0.15, t0+0.1);
  noiseGain.gain.setValueAtTime(0.15, t0+dur*0.7);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t0+dur);
  noise.connect(noiseFilter).connect(noiseGain).connect(master);

  // Start everything
  o1.start(t0); o2.start(t0); o3.start(t0); lfo.start(t0); noise.start(t0);
  o1.stop(t0+dur); o2.stop(t0+dur); o3.stop(t0+dur); lfo.stop(t0+dur); noise.stop(t0+dur);
}

function toggleSound(){
  soundEnabled = !soundEnabled;
  localStorage.setItem('lt_sound', soundEnabled?'on':'off');
  updateSoundBtn();
  showToast(soundEnabled?'Alert sounds on':'Alert sounds muted');
  // Play a test ding when turning ON, so user knows it works
  if(soundEnabled){
    unlockAudio();
    playAlert();
  }
}

function updateSoundBtn(){
  const btn = document.getElementById('soundBtn');
  const svg = soundEnabled ? ICONS.volumeOn : ICONS.volumeOff;
  if(btn){
    btn.innerHTML = svg;
    btn.classList.toggle('muted', !soundEnabled);
  }
  const hamIco = document.getElementById('hamSoundIco');
  if(hamIco) hamIco.innerHTML = svg;
  const hamLbl = document.getElementById('hamSoundLbl');
  if(hamLbl) hamLbl.textContent = soundEnabled ? 'Mute Alerts' : 'Unmute Alerts';
}

// ── THEME (DARK MODE) ─────────────────────────────────────────
// Theme toggle persists across sessions via localStorage. The theme
// is applied to the html element early in the boot sequence (before
// the body renders) to prevent a flash of incorrect theme on reload.
function applyTheme(){
  const dark = localStorage.getItem('lt_theme') === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  // Show the sun icon in dark mode (clicking switches to light) and
  // the moon in light mode (clicking switches to dark)
  const svg = dark ? ICONS.sun : ICONS.moon;
  const btn = document.getElementById('themeBtn');
  if(btn) btn.innerHTML = svg;
  const hamIco = document.getElementById('hamThemeIco');
  if(hamIco) hamIco.innerHTML = svg;
  const hamLbl = document.getElementById('hamThemeLbl');
  if(hamLbl) hamLbl.textContent = dark ? 'Light Mode' : 'Dark Mode';
}

function toggleTheme(){
  const isDark = document.documentElement.classList.contains('dark');
  localStorage.setItem('lt_theme', isDark ? 'light' : 'dark');
  applyTheme();
}

// ── GODZILLA MODE ─────────────────────────────────────────────
// Optional alternate alert sound for users who prefer a more attention
// grabbing notification. Toggleable per-user; persisted in localStorage.
// When enabled, all priority alerts use the synthesized roar instead
// of the standard ding-dong tone.
function toggleGodzilla(){
  godzillaMode = !godzillaMode;
  localStorage.setItem('lt_godzilla', godzillaMode ? 'on' : 'off');
  updateGodzillaBtn();
  showToast(godzillaMode ? 'Godzilla mode activated 🦖' : 'Godzilla mode off');
  // Test the sound when turning on
  if(godzillaMode && soundEnabled){
    unlockAudio();
    playAlert();
  }
}

function updateGodzillaBtn(){
  const btn = document.getElementById('godzillaBtn');
  if(btn) btn.classList.toggle('active', godzillaMode);
  const hamLbl = document.getElementById('hamGodzillaLbl');
  if(hamLbl) hamLbl.textContent = godzillaMode ? 'Godzilla: On' : 'Godzilla: Off';
}

// ── HAMBURGER MENU (MOBILE) ───────────────────────────────────
// Mobile-only navigation drawer. Header tool buttons (Reports, Archive,
// Stats, Print) collapse into this menu when viewport width is below
// the tablet breakpoint. Open/close is managed by a single CSS class
// on the menu container.
function toggleHamburger(){
  const menu = document.getElementById('hamMenu');
  if(menu) menu.classList.toggle('open');
}

function closeHam(){
  const menu = document.getElementById('hamMenu');
  if(menu) menu.classList.remove('open');
}

// Department dropdown toggle. Multiple departments can be added over
// time (e.g. ALO, Siemens, Leads); only one is open at a time. The
// trigger button and menu share a parent .dept-dropdown wrapper that
// gets the .open class to control visibility and chevron rotation.
function toggleDeptDropdown(deptKey){
  const wrapper = document.querySelector(`.dept-dropdown[data-dropdown="${deptKey}"]`);
  if(!wrapper) return;
  const wasOpen = wrapper.classList.contains('open');
  // Close all department dropdowns first so opening another one auto-closes the previous
  closeDeptDropdowns();
  // If the clicked dropdown was closed, open it. (If it was already
  // open, the closeAll call above has already closed it, which is the
  // intended toggle-off behavior.)
  if(!wasOpen) wrapper.classList.add('open');
}

function closeDeptDropdowns(){
  document.querySelectorAll('.dept-dropdown.open').forEach(d => d.classList.remove('open'));
}

// Close any open department dropdown when clicking outside it. Same
// pattern as the hamburger menu; runs in the same global click handler
// space but inspects different DOM ancestors.
document.addEventListener('click', (e)=>{
  if(e.target.closest('.dept-dropdown')) return;
  closeDeptDropdowns();
});

// Close hamburger when clicking outside
document.addEventListener('click', (e)=>{
  const menu = document.getElementById('hamMenu');
  if(!menu || !menu.classList.contains('open')) return;
  if(e.target.closest('.hamburger') || e.target.closest('.ham-menu')) return;
  menu.classList.remove('open');
});

// Updates the .active class on tier 2 header buttons to reflect which
// panel (if any) is currently open. Called from each panel's open/close
// handler so the header always shows the user's current navigation
// context, even when a panel is on top of the board view.
function updateHeaderActiveStates(){
  const isOpen = id => document.getElementById(id)?.classList.contains('open');
  const setActive = (btnId, open) => {
    const btn = document.getElementById(btnId);
    if(btn) btn.classList.toggle('active', open);
  };
  setActive('hdrTodayBtn', isOpen('todayPanel'));
  setActive('hdrAloBtn', isOpen('reportsPanel'));
  setActive('hdrArchiveBtn', isOpen('archivePanel'));
  setActive('hdrStatsBtn', isOpen('statsPanel'));
  setActive('hdrSuggestBtn', isOpen('suggestPanel'));
}

// ── ACTIVITY LOG ──────────────────────────────────────────────
// Append-only activity entries written to a per-issue history
// subcollection in Firestore. Records status changes, priority
// changes, assignee changes, claims, and inter-board moves. Entries
// are immutable once written (enforced by security rules) and are
// rendered in the issue detail view's history tab.
async function logActivity(issueId, type, details){
  await db.collection('issues').doc(issueId).collection('history').add({
    type, details,
    author: user.name,
    role: user.role,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

function describeActivity(h){
  const a = `<b>${esc(h.author)}</b>`;
  switch(h.type){
    case 'created': return `${a} created the issue`;
    case 'status': return `${a} changed status: <b>${COL_LABELS[h.details.from]||h.details.from}</b> → <b>${COL_LABELS[h.details.to]||h.details.to}</b>`;
    case 'priority': return `${a} changed priority: <b>${PRIORITY_LABELS[h.details.from]||h.details.from}</b> → <b>${PRIORITY_LABELS[h.details.to]||h.details.to}</b>`;
    case 'assignee': return h.details.to
      ? `${a} assigned to <b>${esc(h.details.to)}</b>`
      : `${a} unassigned the issue`;
    case 'claimed': return `${a} claimed the issue`;
    case 'moved': return `${a} moved this issue to <b>${esc(h.details.to)}</b>`;
    default: return `${a} made an update`;
  }
}

// ── USER SETUP ────────────────────────────────────────────────
// First-launch identity capture. The user picks a role (ALO, Lead,
// Siemens) and selects or types their first name. Identity is stored
// in localStorage and reused on subsequent visits. There is no
// authentication; the chosen identity is used as the author tag on
// comments, history entries, and report snapshots only.
function selectRole(role){
  selectedRole=role;
  document.getElementById('roleALO').classList.toggle('sel',role==='ALO');
  document.getElementById('roleLead').classList.toggle('sel',role==='Lead');
  document.getElementById('roleSiemens').classList.toggle('sel',role==='Siemens');
}

// Populates the name picker in the setup overlay from the preset
// roster. Called once at boot before the user selects anything.
// The roster is grouped by role so names appear in a logical order.
function populateSetupNames(){
  const sel = document.getElementById('setupName');
  if(!sel) return;
  // Build grouped options from SEED_ROSTER in role display order
  ROLE_ORDER.forEach(role => {
    const names = SEED_ROSTER[role];
    if(!names || !names.length) return;
    const grp = document.createElement('optgroup');
    grp.label = role;
    names.slice().sort((a,b)=>a.localeCompare(b)).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  });
  // When a name is selected, auto-select the matching role so the user
  // doesn't have to click twice for someone whose role is known.
  sel.addEventListener('change', () => {
    const chosen = sel.value;
    ROLE_ORDER.forEach(role => {
      if((SEED_ROSTER[role]||[]).includes(chosen)){
        selectRole(role);
      }
    });
  });
}

function saveUser(){
  const name = document.getElementById('setupName').value.trim();
  if(!name){ alert('Please select your name.'); return; }
  if(!selectedRole){ alert('Please select your role.'); return; }
  user = {name, role:selectedRole, guest:false};
  localStorage.setItem('lt_user', JSON.stringify(user));
  document.getElementById('setupOverlay').classList.add('hidden');
  initApp();
}

// Guest mode: read-only access. The user can browse boards, view issues,
// and read reports but cannot create issues, post comments, or publish.
// Guest identity is not persisted so it is re-prompted on every visit.
function enterGuest(){
  user = {name:'Guest', role:'Guest', guest:true};
  // Intentionally not saving to localStorage so guest is prompted again
  // on next visit. Use the normal identity flow if you want to be remembered.
  document.getElementById('setupOverlay').classList.add('hidden');
  initApp();
}

// Returns true if the current user is in guest (read-only) mode.
function isGuest(){ return user?.guest === true; }

// Gate function: call before any write operation. Shows a friendly
// message and returns false if the user is in guest mode.
function requireIdentity(action){
  if(isGuest()){
    showToast(`Sign in with your name to ${action||'do that'}.`);
    return false;
  }
  return true;
}

function resetUser(){
  if(!confirm('Change your name/role?')) return;
  localStorage.removeItem('lt_user');
  location.reload();
}

// ── INIT ──────────────────────────────────────────────────────
// Application bootstrap. Runs once on DOMContentLoaded after the user
// has been identified. Loads the board list, restores the last-active
// board, kicks off the realtime issue subscription, and triggers any
// scheduled maintenance tasks (archive sweep, snapshot purge).
async function initApp(){
  document.getElementById('userName').textContent = isGuest() ? 'Guest (read-only)' : user.name;
  document.getElementById('userAvatar').textContent = isGuest() ? '?' : initials(user.name);
  // Inject inline SVG icons into all static placeholders. This is a
  // one-time pass at boot; dynamically-rendered elements (cards,
  // hamburger menu items already in the DOM) are handled here too.
  injectStaticIcons();
  updateSoundBtn();
  applyTheme();
  updateGodzillaBtn();
  // Unlock audio on first user interaction (browsers block audio without it)
  document.addEventListener('click', unlockAudio, {once:false, capture:true});
  document.addEventListener('keydown', unlockAudio, {once:false, capture:true});
  await loadRoster();
  await ensureUserInRoster();
  await loadBoards();
  if('Notification' in window && Notification.permission==='default') Notification.requestPermission();
  // Re-render every minute so card ages update and aging warnings appear
  setInterval(()=>{ if(issues.length) renderBoard(); }, 60000);
  // Watch for @mentions of the current user across all comments
  watchForMyMentions();
  // Run archive maintenance: archives resolved cards from past Sundays, purges old archives
  runArchiveMaintenance();
  // Purge old Line Status snapshots (daily at 6am EST)
  purgeSnapshotsDaily();
  // Purge published reports older than 30 days (daily at 6am EST)
  purgePublishedReportsDaily();
  // Set print date
  const pd = document.getElementById('printDate');
  if(pd) pd.textContent = new Date().toLocaleString();
}

// Track recent comment IDs we've already notified on, to prevent duplicate alerts
const notifiedComments = new Set();
let mentionInitTime = null;

function watchForMyMentions(){
  mentionInitTime = Date.now();
  // Use a collectionGroup query to listen for ALL comments across all issues
  db.collectionGroup('comments').where('mentions','array-contains',user.name)
    .onSnapshot(snap=>{
      snap.docChanges().forEach(change=>{
        if(change.type !== 'added') return;
        const c = change.doc.data();
        const id = change.doc.id;
        if(notifiedComments.has(id)) return;
        notifiedComments.add(id);
        // Skip ones from before this session OR from yourself
        const ts = c.createdAt?.toMillis ? c.createdAt.toMillis() : 0;
        if(ts < mentionInitTime - 5000) return;
        if(c.author === user.name) return;
        // Notify
        playAlert();
        if(Notification.permission==='granted'){
          new Notification(`💬 ${c.author} mentioned you`, {body: c.text.slice(0,140)});
        }
        showToast(`${c.author} mentioned you in a comment`);
      });
    });
}

// ── ROSTER ────────────────────────────────────────────────────
// Team member list grouped by role. Used for assignee autocomplete
// and @mention suggestions. Seeded from SEED_ROSTER on first launch
// and persisted to Firestore so the same list is shared across all
// users. Currently append-only; member rename/removal UI is on the
// future enhancements list.
async function loadRoster(){
  const snap = await db.collection('roster').get();
  roster = snap.docs.map(d=>({name:d.id, ...d.data()}));
  // Seed initial roster on first run
  if(!roster.length){
    const batch = db.batch();
    Object.entries(SEED_ROSTER).forEach(([role, names])=>{
      names.forEach(name=>{
        batch.set(db.collection('roster').doc(name), {role, addedAt:firebase.firestore.FieldValue.serverTimestamp()});
      });
    });
    await batch.commit();
    roster = [];
    Object.entries(SEED_ROSTER).forEach(([role, names])=>{
      names.forEach(name=> roster.push({name, role}));
    });
  }
  // Live updates so new users show up immediately
  db.collection('roster').onSnapshot(snap=>{
    roster = snap.docs.map(d=>({name:d.id, ...d.data()}));
  });
}

async function ensureUserInRoster(){
  // Roster is now preset-only. We no longer add names on login.
  // This function is kept as a no-op so existing call sites don't break.
  // If a name needs to be added, it should be added to SEED_ROSTER
  // in the source code and redeployed, or added manually in Firestore.
  if(isGuest()) return;
}

// Group roster by role for assignee autocomplete and @mention suggestions.
// Uses SEED_ROSTER directly so the dropdown only ever shows the preset
// team members regardless of what names are in Firestore. Names added
// during old logins exist in Firestore but are not surfaced here.
function groupedRoster(filterTerm){
  const term = (filterTerm||'').toLowerCase().trim();
  const out = {};
  ROLE_ORDER.forEach(r => out[r] = []);
  ROLE_ORDER.forEach(role => {
    (SEED_ROSTER[role]||[]).forEach(name => {
      if(term && !name.toLowerCase().includes(term)) return;
      out[role].push(name);
    });
    out[role].sort((a,b) => a.localeCompare(b));
  });
  return out;
}

// ── BOARDS ────────────────────────────────────────────────────
// Multiple independent issue boards (one per shift, role group, or
// project, at the team's discretion). Boards are top-level documents
// with only a title and creation timestamp. Issues reference their
// parent board via the boardId field. Switching boards rebinds the
// realtime subscription to issues filtered by the new boardId.
async function loadBoards(){
  const snap = await db.collection('boards').get();
  boards = snap.docs.map(d=>({id:d.id,...d.data()}));
  if(!boards.length){
    const ref = await db.collection('boards').add({title:'Main Board',createdAt:firebase.firestore.FieldValue.serverTimestamp()});
    boards=[{id:ref.id,title:'Main Board'}];
  }
  renderBoardSel();
  switchBoard(boards[0].id);
}

function renderBoardSel(){
  const sel=document.getElementById('boardSel');
  sel.innerHTML=boards.map(b=>`<option value="${b.id}">${esc(b.title)}</option>`).join('');
}

function switchBoard(id){
  boardId=id;
  if(issueSub) issueSub();
  isFirstLoad = true;
  subscribeIssues(id);
}

function openNewBoard(){
  if(!requireIdentity('create boards')) return;
  document.getElementById('newBoardOverlay').classList.remove('hidden');
}
function closeNewBoard(){document.getElementById('newBoardOverlay').classList.add('hidden')}

async function submitNewBoard(){
  const name=document.getElementById('newBoardName').value.trim();
  if(!name) return;
  const ref=await db.collection('boards').add({title:name,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
  boards.push({id:ref.id,title:name});
  renderBoardSel();
  document.getElementById('boardSel').value=ref.id;
  switchBoard(ref.id);
  closeNewBoard();
  document.getElementById('newBoardName').value='';
}

async function deleteBoard(){
  if(boards.length<=1){
    alert('Cannot delete the only remaining board. Create another board first.');
    return;
  }
  const board=boards.find(b=>b.id===boardId);
  if(!board) return;
  const issueCount=issues.length;
  const msg=`Delete board "${board.title}"?\n\nThis will permanently delete the board and all ${issueCount} issue${issueCount===1?'':'s'} on it. This cannot be undone.`;
  if(!confirm(msg)) return;

  try {
    // Delete all issues on this board
    if(issues.length){
      const deletes=issues.map(i=>db.collection('issues').doc(i.id).delete());
      await Promise.all(deletes);
    }
    // Delete the board itself
    await db.collection('boards').doc(boardId).delete();

    // Stop listening, reload boards, switch to first remaining
    if(issueSub){issueSub();issueSub=null}
    await loadBoards();
    showToast('Board deleted.');
  } catch(e){
    // Most commonly this is a Firestore permission error (e.g. security
    // rules denying the delete). Surface it instead of failing silently.
    console.error('Board delete failed:', e);
    alert(`Couldn't delete the board.\n\n${e.message || e}\n\nIf this is a permission error, check the Firestore rules for the 'boards' collection.`);
  }
}

// ── ISSUES REALTIME ───────────────────────────────────────────
// Live subscription to all issues on the active board. Fires on every
// remote change (any user adding, editing, moving, or resolving an
// issue) and re-renders the affected lanes. The subscription is
// scoped to the active boardId; switching boards detaches the prior
// listener via issueSub() before binding a new one.
function subscribeIssues(bid){
  document.getElementById('boardArea').innerHTML='<div class="loading">Loading…</div>';
  let prevIssueMap = {};
  issues.forEach(i=>{ prevIssueMap[i.id]=i });

  issueSub = db.collection('issues').where('boardId','==',bid)
    .onSnapshot(snap=>{
      const newIssues = snap.docs.map(d=>{
        const data = d.data();
        // Normalize legacy 'monitor' priority to 'moderate'. Issues created
        // before the rename still have priority:'monitor' in Firestore. We
        // normalize on read so all display logic, sorting, and aging uses
        // the current value without needing a data migration.
        if(data.priority === 'monitor') data.priority = 'moderate';
        return {id:d.id, ...data};
      });

      if(!isFirstLoad){
        newIssues.forEach(issue=>{
          const prev = prevIssueMap[issue.id];
          // New issue: play alert for all priorities on all new issues,
          // including ones logged by the current user. The sound fires
          // on the Firestore snapshot confirmation, which happens after
          // the issue is fully saved, not while it is being created.
          if(!prev){
            playAlert();
            if(Notification.permission==='granted' && issue.createdBy !== user.name){
              new Notification(`${issue.priority.toUpperCase()}: ${issue.title}`,{body:`Logged by ${issue.createdBy}`});
            }
          }
          // Existing issue escalated to Critical/Urgent
          else if(prev && prev.priority!==issue.priority &&
                  ['critical','urgent'].includes(issue.priority) &&
                  !['critical','urgent'].includes(prev.priority)){
            playAlert();
            if(Notification.permission==='granted'){
              new Notification(`⚠️ Escalated to ${issue.priority.toUpperCase()}`,{body:issue.title});
            }
          }
        });
      }

      issues = newIssues;
      prevIssueMap = {};
      issues.forEach(i=>{ prevIssueMap[i.id]=i });
      isFirstLoad = false;
      renderBoard();
    });
}

// ── RENDER BOARD ──────────────────────────────────────────────
// Main UI rendering for the four-lane Kanban view. Issues are sorted
// within each lane by priority then by creation time. Aging glow is
// applied via CSS class when an issue has sat in its current status
// longer than the threshold defined in AGE_WARN_MS. Card markup is
// built as a single template string and assigned via innerHTML for
// simplicity; volumes are small enough that this is not a perf issue.
function renderBoard(){
  const term = searchTerm.toLowerCase().trim();
  const filtered = issues.filter(i=>{
    if(tFilter!=='all' && i.track!==tFilter) return false;
    if(pFilter!=='all' && i.priority!==pFilter) return false;
    if(term){
      const hay = `${i.title||''} ${i.description||''} ${i.instrumentType||''} ${i.unitNumber||''} ${i.assignee||''} ${i.createdBy||''} ${i.fixDescription||''}`.toLowerCase();
      if(!hay.includes(term)) return false;
    }
    return true;
  });
  // sort: priority first, then newest
  filtered.sort((a,b)=>{
    const pd = (PRIORITY_ORDER[a.priority]||3)-(PRIORITY_ORDER[b.priority]||3);
    if(pd!==0) return pd;
    const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return tb-ta;
  });

  document.getElementById('boardArea').innerHTML = COLS.map(col=>{
    const cards = filtered.filter(i=>i.status===col);
    return `<div class="col">
      <div class="col-hdr ${col}">
        <div class="col-dot ${col}"></div>
        <div class="col-name">${COL_LABELS[col]}</div>
        <div class="col-cnt">${cards.length}</div>
      </div>
      <div class="col-cards">
        ${cards.length ? cards.map(renderCard).join('') : '<div class="col-empty">No issues</div>'}
      </div>
    </div>`;
  }).join('');
}

function renderCard(issue){
  const inst = [issue.instrumentType, issue.unitNumber].filter(Boolean).join(' ');
  const tc = issue.track||'general';
  const tl = tc==='op'?'OP':tc==='bb'?'BB':'GEN';
  const cc = issue.commentCount||0;
  const ai = initials(issue.assignee||'');
  const aging = isAging(issue);
  const age = fmtAge(issue.createdAt);
  const agingTitle = aging ? 'title="This issue has been open longer than expected for its priority. Critical: over 1 hr, Urgent: over 2 hr, Moderate: over 24 hr, Low: over 7 days."' : '';
  const priorityTitles = {critical:'Critical: line is down or a major process is stopped.',urgent:'Urgent: line is running but degraded, needs attention soon.',moderate:'Moderate: something to watch, not currently blocking.',low:'Low: non-urgent, address when time allows.'};
  return `<div class="card ${tc} ${aging?'aging':''}" onclick="openDetail('${issue.id}')" ${agingTitle}>
    <div class="card-top">
      <span class="pbadge ${issue.priority}" title="${priorityTitles[issue.priority]||''}">${issue.priority}</span>
      <span class="tbadge ${tc}">${tl}</span>
    </div>
    <div class="card-title">${esc(issue.title)}</div>
    ${inst?`<div class="card-inst">${esc(inst)}</div>`:''}
    <div class="card-bot">
      ${issue.assignee
        ? `<div class="a-chip"><div class="a-dot">${ai}</div>${esc(issue.assignee)}</div>`
        : '<span style="font-size:11px;color:#94a3b8">Unassigned</span>'}
      ${cc>0?`<div class="cc">${ICONS.comment} ${cc}</div>`:''}
    </div>
    ${age && issue.status!=='resolved' ? `<div class="card-time ${aging?'warn':''}">${aging?ICONS.warning+' ':''}Open ${age}</div>` : ''}
  </div>`;
}

// ── NEW ISSUE ─────────────────────────────────────────────────
// Modal form for creating a new issue card. Captures title, priority,
// track (BB or OP), instrument type, unit number, and optional
// assignee. On submit, the card is written to Firestore which triggers
// a realtime update on every connected client.
function openNewIssue(){
  if(!requireIdentity('log issues')) return;
  document.getElementById('issueAssignee').value='';
  document.getElementById('newIssueOverlay').classList.remove('hidden');
  document.getElementById('issueTitle').focus();
}
function closeNewIssue(){
  document.getElementById('newIssueOverlay').classList.add('hidden');
  ['issueTitle','issueDesc','issueUnit','issueAssignee'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('issuePriority').value='moderate';
  document.getElementById('issueTrack').value='op';
  document.getElementById('issueInstrument').value='';
}

async function submitNewIssue(){
  const title=document.getElementById('issueTitle').value.trim();
  if(!title){alert('Title is required.');return}
  const ref = await db.collection('issues').add({
    boardId,title,
    description:document.getElementById('issueDesc').value.trim(),
    priority:document.getElementById('issuePriority').value,
    status:'open',
    track:document.getElementById('issueTrack').value,
    instrumentType:document.getElementById('issueInstrument').value,
    unitNumber:document.getElementById('issueUnit').value.trim(),
    assignee:document.getElementById('issueAssignee').value.trim(),
    createdBy:user.name,
    createdAt:firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt:firebase.firestore.FieldValue.serverTimestamp(),
    commentCount:0
  });
  await logActivity(ref.id, 'created', {});
  closeNewIssue();
  showToast('Issue logged.');
}

// ── ISSUE DETAIL ──────────────────────────────────────────────
// Modal panel for viewing and editing a single issue. Shows the full
// card content plus comment thread, activity history tab, and edit
// controls for status, priority, assignee, and instrument tags. Maintains
// its own realtime subscription for the issue's comments and history
// subcollections so changes from other users appear immediately.
function maybeCloseDetail(e){if(e.target===document.getElementById('detailOverlay')) closeDetail()}

async function openDetail(issueId){
  const issue = issues.find(i=>i.id===issueId);
  if(!issue) return;
  document.getElementById('detailModal').innerHTML = buildDetailHTML(issue);
  document.getElementById('detailOverlay').classList.remove('hidden');
  if(detailSub) detailSub();
  detailSub = db.collection('issues').doc(issueId).collection('comments')
    .orderBy('createdAt')
    .onSnapshot(snap=>{
      const cs=snap.docs.map(d=>({id:d.id,...d.data()}));
      const el=document.getElementById('clist');
      if(!el) return;
      el.innerHTML = cs.length ? cs.map(c=>renderComment(c, issueId)).join('') : '<div style="color:#94a3b8;font-size:13px">No updates yet.</div>';
      el.scrollTop=el.scrollHeight;
    });
}

// Render a single comment including parsed mentions and reactions
function renderComment(c, issueId){
  const text = parseMentions(c.text);
  const reactions = c.reactions || {};
  const reactHtml = REACTIONS.map(r=>{
    const users = reactions[r.key] || [];
    const mine = users.includes(user.name);
    const tip = users.length ? users.join(', ') : r.label;
    return `<button class="react-btn ${mine?'mine':''}" title="${esc(tip)}" onclick="toggleReaction('${issueId}','${c.id}','${r.key}')">
      <span class="react-emoji">${r.emoji}</span>${users.length?`<span class="react-cnt">${users.length}</span>`:''}
    </button>`;
  }).join('');
  return `<div class="ci">
    <div class="ci-author">${esc(c.author)} <span style="font-weight:400;color:var(--muted)">(${c.role||''})</span></div>
    <div class="ci-text">${text}</div>
    <div class="ci-time">${fmtTime(c.createdAt)}</div>
    <div class="reactions">${reactHtml}</div>
  </div>`;
}

// Parse @mentions in text and wrap them in styled spans
function parseMentions(text){
  if(!text) return '';
  const escaped = esc(text);
  // Match @Name where Name is in roster (case-insensitive, longest match first)
  const names = roster.map(r=>r.name).sort((a,b)=>b.length-a.length);
  let result = escaped;
  names.forEach(name=>{
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const regex = new RegExp(`@(${escName})\\b`, 'gi');
    result = result.replace(regex, '<span class="mention">@$1</span>');
  });
  return result;
}

function buildDetailHTML(i){
  const inst=[i.instrumentType,i.unitNumber].filter(Boolean).join(' ');
  const trackDot = i.track==='op'?'dot-op':i.track==='bb'?'dot-bb':'dot-gen';
  const trackName = i.track==='op'?'Optimus Prime':i.track==='bb'?'Bumblebee':'General';
  const tl = `<span class="dot ${trackDot}"></span>${trackName}`;
  return `
  <div class="mhdr">
    <div style="flex:1">
      <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
        <span class="pbadge ${i.priority}">${i.priority}</span>
        <span style="font-size:11px;background:#f1f5f9;color:#475569;padding:2px 8px;border-radius:4px;font-weight:600">${tl}</span>
        ${inst?`<span style="font-size:11px;background:#f0fdf4;color:#15803d;padding:2px 8px;border-radius:4px;font-weight:700;font-family:monospace">${esc(inst)}</span>`:''}
      </div>
      <div class="mtitle">${esc(i.title)}</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:4px">
        Logged by ${esc(i.createdBy)} · ${fmtTime(i.createdAt)}
        ${i.status!=='resolved' && fmtAge(i.createdAt) ? ` · <span style="${isAging(i)?'color:#dc2626;font-weight:600':''}">Open ${fmtAge(i.createdAt)}</span>` : ''}
      </div>
    </div>
    <button class="mclose" onclick="closeDetail()">×</button>
  </div>

  <div class="dbody">
    <div>
      <div class="sec-lbl">Description</div>
      <div class="desc-box">${i.description ? esc(i.description) : '<span style="color:#94a3b8">No description.</span>'}</div>

      <div id="fixContainer">
        ${i.fixDescription ? `
        <div class="fix-box">
          <div class="fix-box-lbl">How it was fixed</div>
          <div class="fix-box-text">${esc(i.fixDescription)}</div>
          <div class="fix-box-meta">
            Fixed by ${esc(i.fixedBy||'?')} · ${fmtTime(i.fixedAt)}
            <span class="fix-box-edit" onclick="showFixInput('${i.id}','${esc(i.fixDescription)}')">Edit</span>
          </div>
        </div>
        ` : i.status === 'resolved' ? `
        <div class="fix-box" style="border-style:dashed;background:transparent;opacity:.75">
          <div class="fix-box-lbl">How it was fixed</div>
          <div class="fix-box-text" style="color:var(--muted)">No fix description yet.
            <span class="fix-box-edit" onclick="showFixInput('${i.id}','')">Add one</span>
          </div>
        </div>
        ` : ''}
      </div>

      <div class="sec-lbl" style="margin-bottom:9px">Updates & Comments</div>
      <div class="clist" id="clist"><div style="color:#94a3b8;font-size:13px">Loading…</div></div>
      <div class="cinput-row" style="position:relative">
        <textarea class="fc" id="ctext" maxlength="280" placeholder="Add an update or note… (use @ to mention someone)"
                  oninput="onCommentInput(event)"
                  onkeydown="onCommentKeydown(event)"></textarea>
        <div class="mention-list" id="mentionList"></div>
      </div>
      <div class="cinput-meta">
        <div class="ccount"><span id="ccnt">0</span>/280</div>
        <button class="btn btn-p" style="padding:6px 13px;font-size:12px" onclick="postComment('${i.id}')">Post Update</button>
      </div>

      <div class="history-toggle" onclick="toggleHistory('${i.id}')" id="histToggle">
        <span id="histArrow">▸</span> <span id="histLbl">Show History</span>
      </div>
      <div class="history-list" id="histList"></div>
    </div>

    <div class="sidebar">
      <div class="sb-sec">
        <div class="sb-lbl">Status</div>
        <select class="fc" onchange="updateField('${i.id}','status',this.value)">
          ${COLS.map(s=>`<option value="${s}" ${i.status===s?'selected':''}>${COL_LABELS[s]}</option>`).join('')}
        </select>
      </div>
      <div class="sb-sec">
        <div class="sb-lbl">Priority</div>
        <select class="fc" onchange="updateField('${i.id}','priority',this.value)">
          <option value="critical" ${i.priority==='critical'?'selected':''}>● Critical</option>
          <option value="urgent" ${i.priority==='urgent'?'selected':''}>● Urgent</option>
          <option value="moderate" ${i.priority==='moderate'?'selected':''}>● Moderate</option>
          <option value="low" ${i.priority==='low'?'selected':''}>● Low</option>
        </select>
      </div>
      <div class="sb-sec">
        <div class="sb-lbl">Assigned To</div>
        <div class="assign-wrap">
          <div class="assign-row">
            <input class="fc" id="dAssign" value="${esc(i.assignee||'')}" placeholder="Unassigned" autocomplete="off"
                   oninput="showAssignDropdown('dAssign','dAssignList',this.value)"
                   onfocus="showAssignDropdown('dAssign','dAssignList',this.value)"
                   onblur="setTimeout(()=>hideAssignDropdown('dAssignList'),180)" />
            <button class="btn-me" onclick="claimIssue('${i.id}')">Me</button>
          </div>
          <div class="assign-list" id="dAssignList"></div>
        </div>
        <button class="btn btn-g" style="margin-top:6px;width:100%;font-size:12px" onclick="saveAssign('${i.id}')">Save Assignee</button>
      </div>
      <div class="sb-sec">
        <div class="sb-lbl">Track</div>
        <div class="sb-val">${tl}</div>
      </div>
      ${inst?`<div class="sb-sec"><div class="sb-lbl">Instrument</div><div class="sb-val" style="font-family:monospace">${esc(inst)}</div></div>`:''}
      <div class="sb-sec">
        <div class="sb-lbl">Move to Board</div>
        <select class="fc" onchange="moveIssueToBoard('${i.id}',this.value);this.value=''">
          <option value="">Select board...</option>
          ${boards.filter(b=>b.id!==boardId).map(b=>`<option value="${b.id}">${esc(b.title)}</option>`).join('')}
        </select>
      </div>
      <div class="sb-del">
        <button class="btn btn-d" style="width:100%;font-size:12px" onclick="deleteIssue('${i.id}')">Delete Issue</button>
      </div>
    </div>
  </div>`;
}

function closeDetail(){
  document.getElementById('detailOverlay').classList.add('hidden');
  if(detailSub){detailSub();detailSub=null}
  if(historySub){historySub();historySub=null}
}

// Shows the inline fix description input in the detail view.
// Called when the user clicks "Add fix description" or "Edit".
// Replaces the current fix box content with an editable textarea
// and Save button, matching the style of the comments input.
function showFixInput(issueId, current){
  const container = document.getElementById('fixContainer');
  if(!container) return;
  container.innerHTML = `
    <div class="fix-box">
      <div class="fix-box-lbl">How it was fixed</div>
      <div class="cinput-row" style="position:relative;margin-top:6px">
        <textarea class="fc" id="fixText" placeholder="Briefly describe what fixed this issue. This will be visible to the whole team in the resolved view and the archive." style="min-height:72px;font-size:13px">${esc(current||'')}</textarea>
      </div>
      <div style="display:flex;gap:8px;margin-top:7px;justify-content:flex-end">
        <button class="btn btn-g" style="font-size:12px;padding:5px 12px" onclick="cancelFixInput('${issueId}')">Cancel</button>
        <button class="btn btn-p" style="font-size:12px;padding:5px 12px" onclick="saveFixDescription('${issueId}')">Save Fix</button>
      </div>
    </div>
  `;
  document.getElementById('fixText')?.focus();
}

// Cancels the inline fix input and restores the previous display.
// Re-fetches the current issue state so the box reflects whatever
// was last saved rather than a stale cached value.
function cancelFixInput(issueId){
  const issue = issues.find(i=>i.id===issueId);
  if(issue) renderFixBox(issueId, issue);
}

// Saves the fix description from the inline textarea to Firestore.
async function saveFixDescription(issueId){
  const text = document.getElementById('fixText')?.value.trim();
  const update = {updatedAt: firebase.firestore.FieldValue.serverTimestamp()};
  if(text){
    update.fixDescription = text;
    update.fixedBy = user.name;
    update.fixedAt = firebase.firestore.FieldValue.serverTimestamp();
  } else {
    update.fixDescription = firebase.firestore.FieldValue.delete();
    update.fixedBy = firebase.firestore.FieldValue.delete();
    update.fixedAt = firebase.firestore.FieldValue.delete();
  }
  await db.collection('issues').doc(issueId).update(update);
  if(text) await logActivity(issueId, 'fix', {text});
  showToast(text ? 'Fix description saved.' : 'Fix description removed.');
  // Refresh the fix box from the updated Firestore doc
  const snap = await db.collection('issues').doc(issueId).get();
  if(snap.exists){
    const issue = {id:snap.id, ...snap.data()};
    renderFixBox(issueId, issue);
  }
}

// Renders the read/edit state of the fix description box into
// #fixContainer without re-rendering the whole detail view.
function renderFixBox(issueId, issue){
  const container = document.getElementById('fixContainer');
  if(!container) return;
  if(issue.fixDescription){
    container.innerHTML = `
      <div class="fix-box">
        <div class="fix-box-lbl">How it was fixed</div>
        <div class="fix-box-text">${esc(issue.fixDescription)}</div>
        <div class="fix-box-meta">
          Fixed by ${esc(issue.fixedBy||'?')} · ${fmtTime(issue.fixedAt)}
          <span class="fix-box-edit" onclick="showFixInput('${issueId}','${esc(issue.fixDescription)}')">Edit</span>
        </div>
      </div>
    `;
  } else if(issue.status === 'resolved'){
    container.innerHTML = `
      <div class="fix-box" style="border-style:dashed;background:transparent;opacity:.75">
        <div class="fix-box-lbl">How it was fixed</div>
        <div class="fix-box-text" style="color:var(--muted)">No fix description yet.
          <span class="fix-box-edit" onclick="showFixInput('${issueId}','')">Add one</span>
        </div>
      </div>
    `;
  } else {
    container.innerHTML = '';
  }
}

async function updateField(id, field, val){
  const issue = issues.find(i=>i.id===id);
  const prev = issue ? issue[field] : null;
  const update = {[field]:val, updatedAt:firebase.firestore.FieldValue.serverTimestamp()};

  await db.collection('issues').doc(id).update(update);
  if(['status','priority'].includes(field) && prev !== val){
    await logActivity(id, field, {from:prev, to:val});
  }
  // When status changes to resolved and the detail view is open,
  // refresh the fix container so the "Add one" prompt appears
  // immediately without the user having to close and reopen the card.
  if(field === 'status' && val === 'resolved' && prev !== 'resolved'){
    const updated = {id, ...issue, status:'resolved'};
    renderFixBox(id, updated);
  }
  // When status changes away from resolved, clear the fix container
  if(field === 'status' && val !== 'resolved' && prev === 'resolved'){
    const container = document.getElementById('fixContainer');
    if(container) container.innerHTML = '';
  }
}

function toggleHistory(issueId){
  const list = document.getElementById('histList');
  const arrow = document.getElementById('histArrow');
  const lbl = document.getElementById('histLbl');
  if(!list) return;

  if(list.classList.contains('open')){
    // Close
    list.classList.remove('open');
    arrow.textContent = '▸';
    lbl.textContent = 'Show History';
    if(historySub){historySub();historySub=null}
  } else {
    // Open
    list.classList.add('open');
    arrow.textContent = '▾';
    lbl.textContent = 'Hide History';
    list.innerHTML = '<div style="color:#94a3b8;font-size:12px">Loading…</div>';
    historySub = db.collection('issues').doc(issueId).collection('history')
      .orderBy('createdAt','desc')
      .onSnapshot(snap=>{
        const items = snap.docs.map(d=>d.data());
        list.innerHTML = items.length
          ? items.map(h=>`<div class="h-entry">${describeActivity(h)} <span class="h-time">· ${fmtTime(h.createdAt)}</span></div>`).join('')
          : '<div style="color:#94a3b8;font-size:12px">No history yet.</div>';
      });
  }
}

async function postComment(issueId){
  if(!requireIdentity('post comments')) return;
  const text=document.getElementById('ctext')?.value.trim();
  if(!text) return;
  const mentions = extractMentions(text);
  await db.collection('issues').doc(issueId).collection('comments').add({
    text, author:user.name, role:user.role,
    mentions: mentions,
    reactions: {},
    createdAt:firebase.firestore.FieldValue.serverTimestamp()
  });
  await db.collection('issues').doc(issueId).update({
    commentCount:firebase.firestore.FieldValue.increment(1),
    updatedAt:firebase.firestore.FieldValue.serverTimestamp()
  });
  const el=document.getElementById('ctext');
  if(el){el.value='';document.getElementById('ccnt').textContent='0'}
  hideMentionList();
}

async function saveAssign(id){
  const val=document.getElementById('dAssign')?.value.trim()||'';
  const issue = issues.find(i=>i.id===id);
  const prev = issue ? (issue.assignee||'') : '';
  await db.collection('issues').doc(id).update({assignee:val, updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
  if(prev !== val){
    await logActivity(id, 'assignee', {from:prev, to:val});
  }
  showToast('Assignee saved.');
}

async function claimIssue(id){
  const el=document.getElementById('dAssign');
  if(el) el.value=user.name;
  const issue = issues.find(i=>i.id===id);
  const prev = issue ? (issue.assignee||'') : '';
  await db.collection('issues').doc(id).update({assignee:user.name, updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
  if(prev !== user.name){
    await logActivity(id, 'claimed', {});
  }
  showToast('Assigned to you.');
}

async function deleteIssue(id){
  if(!confirm('Delete this issue? This cannot be undone.')) return;
  await db.collection('issues').doc(id).delete();
  closeDetail();
  showToast('Issue deleted.');
}

async function moveIssueToBoard(issueId, targetBoardId){
  if(!targetBoardId) return;
  const target = boards.find(b=>b.id===targetBoardId);
  if(!target) return;
  if(!confirm(`Move this issue to "${target.title}"?`)) return;
  await db.collection('issues').doc(issueId).update({
    boardId: targetBoardId,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await logActivity(issueId, 'moved', {to: target.title});
  closeDetail();
  showToast(`Moved to "${target.title}".`);
}

// ── SEARCH ────────────────────────────────────────────────────
// Client-side text search across the active board. Matches against
// issue title, instrument type, unit number, and assignee. Case
// insensitive substring match; no ranking. Filter is applied at
// render time so the underlying issue array is not mutated.
function onSearch(val){
  searchTerm = val;
  renderBoard();
}

// ── ASSIGNEE AUTOCOMPLETE ──────────────────────────────────────
// Dropdown suggester for the assignee field on the new issue form.
// Matches against the full roster grouped by role (Leads first, then
// ALOs, then Siemens). Closes on outside click or Escape.
function showAssignDropdown(inputId, listId, term){
  const list = document.getElementById(listId);
  if(!list) return;
  const grouped = groupedRoster(term);
  const totalMatches = ROLE_ORDER.reduce((sum,r)=>sum+grouped[r].length,0);

  let html = `<div class="assign-item unassign" onclick="pickAssignee('${inputId}','${listId}','')">Unassigned</div>`;
  if(totalMatches === 0){
    html += '<div class="assign-empty">No matching names.</div>';
  } else {
    ROLE_ORDER.forEach(role=>{
      if(!grouped[role].length) return;
      html += `<div class="assign-group-hdr">${ROLE_LABELS[role]}</div>`;
      grouped[role].forEach(name=>{
        html += `<div class="assign-item" onclick="pickAssignee('${inputId}','${listId}','${esc(name).replace(/'/g,"\\'")}')">
          <div class="a-dot">${initials(name)}</div>${esc(name)}
        </div>`;
      });
    });
  }
  list.innerHTML = html;
  list.classList.add('open');
}

function hideAssignDropdown(listId){
  const list = document.getElementById(listId);
  if(list) list.classList.remove('open');
}

function pickAssignee(inputId, listId, name){
  const input = document.getElementById(inputId);
  if(input) input.value = name;
  hideAssignDropdown(listId);
}

// ── FILTERS ───────────────────────────────────────────────────
// Track and priority filters applied at the top of the board. Both
// filters are independent and combine via AND. Like search, filters
// are applied at render time without mutating the source array.
function setTF(v){
  tFilter=v;
  const map={all:'fAll',op:'fOP',bb:'fBB',general:'fGen'};
  const cls={all:'c-all',op:'c-op',bb:'c-bb',general:'c-gen'};
  Object.values(map).forEach(id=>document.getElementById(id).className='chip');
  document.getElementById(map[v]).classList.add(cls[v]);
  renderBoard();
}

function setPF(v){
  pFilter=v;
  const map={all:'pAll',critical:'pCrit',urgent:'pUrg',moderate:'pMon',low:'pLow'};
  const cls={all:'c-all',critical:'c-critical',urgent:'c-urgent',moderate:'c-moderate',low:'c-low'};
  Object.values(map).forEach(id=>document.getElementById(id).className='chip');
  document.getElementById(map[v]).classList.add(cls[v]);
  renderBoard();
}

// ── MENTIONS IN COMMENTS ──────────────────────────────────────
// @mention parser and dropdown for the comment textarea. When the
// user types '@' followed by a partial name, a suggestion list of
// matching roster members appears. Selecting one inserts the full
// name into the comment and fires a notification (toast + sound) to
// any matching user currently viewing the app.
function onCommentInput(e){
  const ta = e.target;
  document.getElementById('ccnt').textContent = ta.value.length;

  // Detect @ trigger: find the most recent @ before the cursor
  const cursor = ta.selectionStart;
  const text = ta.value.slice(0, cursor);
  const atMatch = text.match(/@([A-Za-z]*)$/);
  if(atMatch){
    const term = atMatch[1].toLowerCase();
    const matches = roster
      .filter(r=>r.name.toLowerCase().startsWith(term))
      .sort((a,b)=>a.name.localeCompare(b.name))
      .slice(0,8);
    if(matches.length){
      showMentionList(matches, ta, cursor - atMatch[0].length);
      return;
    }
  }
  hideMentionList();
}

function onCommentKeydown(e){
  const list = document.getElementById('mentionList');
  if(!list || !list.classList.contains('open')) return;
  const items = list.querySelectorAll('.mention-item');
  if(!items.length) return;
  const active = list.querySelector('.mention-item.active');
  let idx = active ? Array.from(items).indexOf(active) : -1;

  if(e.key==='ArrowDown'){
    e.preventDefault();
    idx = (idx+1) % items.length;
    items.forEach(el=>el.classList.remove('active'));
    items[idx].classList.add('active');
  } else if(e.key==='ArrowUp'){
    e.preventDefault();
    idx = (idx-1+items.length) % items.length;
    items.forEach(el=>el.classList.remove('active'));
    items[idx].classList.add('active');
  } else if(e.key==='Enter' || e.key==='Tab'){
    e.preventDefault();
    const target = active || items[0];
    target.click();
  } else if(e.key==='Escape'){
    hideMentionList();
  }
}

function showMentionList(matches, textarea, atPos){
  const list = document.getElementById('mentionList');
  if(!list) return;
  // Position the dropdown near the textarea
  list.style.top = (textarea.offsetTop + textarea.offsetHeight + 3) + 'px';
  list.style.left = textarea.offsetLeft + 'px';
  list.innerHTML = matches.map((r,i)=>`<div class="mention-item ${i===0?'active':''}" onmousedown="event.preventDefault();insertMention('${esc(r.name).replace(/'/g,"\\'")}',${atPos})">
    <div class="a-dot">${initials(r.name)}</div>${esc(r.name)}<span class="mention-role">${r.role||''}</span>
  </div>`).join('');
  list.classList.add('open');
}

function hideMentionList(){
  const list = document.getElementById('mentionList');
  if(list) list.classList.remove('open');
}

function insertMention(name, atPos){
  const ta = document.getElementById('ctext');
  if(!ta) return;
  const before = ta.value.slice(0, atPos);
  const afterCursor = ta.value.slice(ta.selectionStart);
  ta.value = before + '@' + name + ' ' + afterCursor;
  const newPos = before.length + name.length + 2;
  ta.setSelectionRange(newPos, newPos);
  ta.focus();
  document.getElementById('ccnt').textContent = ta.value.length;
  hideMentionList();
}

// Extract @Name mentions that match real roster members
function extractMentions(text){
  if(!text) return [];
  const found = new Set();
  const names = roster.map(r=>r.name).sort((a,b)=>b.length-a.length);
  names.forEach(name=>{
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const regex = new RegExp(`@(${escName})\\b`, 'i');
    if(regex.test(text)) found.add(name);
  });
  return Array.from(found);
}

// ── REACTIONS ─────────────────────────────────────────────────
// Emoji reactions on individual comments. Three fixed options:
// thumbs-up (acknowledge), eyes (looking into it), and check (done).
// Reactions are stored as a map of emoji-to-username-array on the
// comment document; toggling adds or removes the current user.
async function toggleReaction(issueId, commentId, key){
  const ref = db.collection('issues').doc(issueId).collection('comments').doc(commentId);
  const snap = await ref.get();
  const data = snap.data() || {};
  const reactions = data.reactions || {};
  const list = reactions[key] || [];
  const idx = list.indexOf(user.name);
  if(idx >= 0){
    list.splice(idx, 1);
  } else {
    list.push(user.name);
  }
  reactions[key] = list;
  await ref.update({reactions});
}

// ── BUNCH 3: ARCHIVE / STATS / CSV ─────────────────────────────
// Subsystems for historical data: weekly archive of resolved issues,
// stats dashboard with rollup metrics, and CSV export from both views.
// Archive maintenance runs once per session if conditions are met
// (Sunday 6am EST cutoff has passed since the last run).
// Compute the most recent Sunday 6am EST as a UTC timestamp.
// EST is UTC-5 (we ignore DST drift for simplicity, close enough for archival).
function lastSunday6amEST(){
  const now = new Date();
  // Convert to a Date representing "now in EST"
  const utcMs = now.getTime();
  const estMs = utcMs - 5*60*60*1000;
  const est = new Date(estMs);
  // Find this past Sunday 6am in EST
  const dow = est.getUTCDay(); // 0=Sun
  const target = new Date(est);
  target.setUTCHours(6,0,0,0);
  if(dow===0 && est.getUTCHours() < 6){
    // It's Sunday before 6am EST, use last Sunday
    target.setUTCDate(target.getUTCDate() - 7);
  } else {
    target.setUTCDate(target.getUTCDate() - dow);
  }
  // Convert back to UTC ms
  return target.getTime() + 5*60*60*1000;
}

// Returns Monday 00:00 UTC for the week containing the given timestamp (used as week bucket)
function weekKey(ts){
  const d = new Date(ts);
  const dow = d.getUTCDay();
  const monOffset = dow===0 ? -6 : 1-dow;
  d.setUTCDate(d.getUTCDate() + monOffset);
  d.setUTCHours(0,0,0,0);
  return d.getTime();
}

function fmtWeekRange(weekStartMs){
  const start = new Date(weekStartMs);
  const end = new Date(weekStartMs + 6*24*60*60*1000);
  const opt = {month:'short', day:'numeric'};
  return `Week of ${start.toLocaleDateString(undefined,opt)} – ${end.toLocaleDateString(undefined,{...opt, year:'numeric'})}`;
}

// Run on every app load. Archives Resolved cards if the last archive run was before
// the most recent Sunday 6am EST. Also purges archives older than 90 days.
async function runArchiveMaintenance(){
  try {
    const cutoff = lastSunday6amEST();
    const metaRef = db.collection('meta').doc('archive');
    const metaSnap = await metaRef.get();
    const lastRun = metaSnap.exists ? (metaSnap.data().lastRun?.toMillis?.() || 0) : 0;

    if(lastRun < cutoff){
      // Archive Resolved issues across all boards
      const resolvedSnap = await db.collection('issues').where('status','==','resolved').get();
      let archived = 0;
      for(const doc of resolvedSnap.docs){
        const data = doc.data();
        const archivedAt = firebase.firestore.FieldValue.serverTimestamp();
        const wk = weekKey(Date.now());
        // Copy to archive collection (preserve original ID for reference)
        await db.collection('archive').doc(doc.id).set({
          ...data,
          archivedAt,
          weekBucket: wk,
          originalId: doc.id
        });
        // Copy comments and history (best effort, keep small via batch where possible)
        const commentsSnap = await doc.ref.collection('comments').get();
        for(const c of commentsSnap.docs){
          await db.collection('archive').doc(doc.id).collection('comments').doc(c.id).set(c.data());
        }
        const historySnap = await doc.ref.collection('history').get();
        for(const h of historySnap.docs){
          await db.collection('archive').doc(doc.id).collection('history').doc(h.id).set(h.data());
        }
        // Delete original (and its subcollections)
        for(const c of commentsSnap.docs) await c.ref.delete();
        for(const h of historySnap.docs) await h.ref.delete();
        await doc.ref.delete();
        archived++;
      }
      await metaRef.set({lastRun: firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
      if(archived) console.log(`Archived ${archived} resolved issue(s).`);
    }

    // Purge archives older than 90 days
    const purgeBefore = Date.now() - 90*24*60*60*1000;
    const oldSnap = await db.collection('archive').where('archivedAt','<', new Date(purgeBefore)).get();
    let purged = 0;
    for(const doc of oldSnap.docs){
      const cs = await doc.ref.collection('comments').get();
      for(const c of cs.docs) await c.ref.delete();
      const hs = await doc.ref.collection('history').get();
      for(const h of hs.docs) await h.ref.delete();
      await doc.ref.delete();
      purged++;
    }
    if(purged) console.log(`Purged ${purged} archived issue(s) older than 90 days.`);
  } catch(e){
    console.warn('Archive maintenance failed (non-fatal):', e);
  }
}

// ── ARCHIVE VIEWER ────────────────────────────────────────────
// Read-only browser for archived issues. Filterable by week (Sunday
// to Saturday), board, and search term. Selecting an issue opens a
// read-only detail view with the comment thread and history at the
// time of archival. Archived issues older than 90 days are purged
// during the same Sunday maintenance run.
let archiveData = [];

async function openArchive(){
  document.getElementById('archivePanel').classList.add('open');
  updateHeaderActiveStates();
  // Populate board filter
  const boardSel = document.getElementById('archBoard');
  boardSel.innerHTML = '<option value="">All boards</option>' + boards.map(b=>`<option value="${b.id}">${esc(b.title)}</option>`).join('');
  // Load archive data
  const snap = await db.collection('archive').orderBy('archivedAt','desc').get();
  archiveData = snap.docs.map(d=>({id:d.id, ...d.data()}));
  // Build week dropdown from unique weekBuckets
  const weeks = [...new Set(archiveData.map(a=>a.weekBucket).filter(Boolean))].sort((a,b)=>b-a);
  const weekSel = document.getElementById('archWeek');
  weekSel.innerHTML = '<option value="">All weeks</option>' + weeks.map(w=>`<option value="${w}">${fmtWeekRange(w)}</option>`).join('');
  renderArchive();
}

function closeArchive(){
  document.getElementById('archivePanel').classList.remove('open');
  updateHeaderActiveStates();
}

function renderArchive(){
  const wk = document.getElementById('archWeek').value;
  const bd = document.getElementById('archBoard').value;
  const term = (document.getElementById('archSearch').value||'').toLowerCase().trim();
  let items = archiveData;
  if(wk) items = items.filter(a=>String(a.weekBucket)===wk);
  if(bd) items = items.filter(a=>a.boardId===bd);
  if(term){
    items = items.filter(a=>{
      const hay = `${a.title||''} ${a.description||''} ${a.instrumentType||''} ${a.unitNumber||''} ${a.assignee||''} ${a.createdBy||''} ${a.fixDescription||''}`.toLowerCase();
      return hay.includes(term);
    });
  }
  const list = document.getElementById('archList');
  if(!items.length){
    list.innerHTML = '<div class="arch-empty">No archived issues match your filters.</div>';
    return;
  }
  list.innerHTML = items.map(a=>{
    const inst = [a.instrumentType, a.unitNumber].filter(Boolean).join(' ');
    const tc = a.track||'general';
    const tl = tc==='op'?'OP':tc==='bb'?'BB':'GEN';
    const board = boards.find(b=>b.id===a.boardId);
    const boardName = board ? board.title : '(deleted board)';
    return `<div class="arch-card ${tc}" onclick="openArchiveDetail('${a.id}')">
      <div class="arch-card-top">
        <span class="pbadge ${a.priority}">${a.priority||''}</span>
        <span class="tbadge ${tc}">${tl}</span>
        ${inst?`<span style="font-size:10px;background:#f0fdf4;color:#15803d;padding:1px 6px;border-radius:3px;font-weight:700;font-family:monospace">${esc(inst)}</span>`:''}
      </div>
      <div class="arch-card-title">${esc(a.title||'')}</div>
      <div class="arch-card-meta">
        ${esc(boardName)} · Logged by ${esc(a.createdBy||'?')} · Resolved by ${esc(a.assignee||'?')}
        · Archived ${fmtTime(a.archivedAt)}
      </div>
    </div>`;
  }).join('');
}

async function openArchiveDetail(archId){
  const a = archiveData.find(x=>x.id===archId);
  if(!a) return;
  // Build a read-only detail view in the existing detail modal
  const modal = document.getElementById('detailModal');
  const inst = [a.instrumentType, a.unitNumber].filter(Boolean).join(' ');
  const trackName = a.track==='op'?'Optimus Prime':a.track==='bb'?'Bumblebee':'General';
  const board = boards.find(b=>b.id===a.boardId);

  // Pull comments and history for this archived issue
  const [csSnap, hsSnap] = await Promise.all([
    db.collection('archive').doc(archId).collection('comments').orderBy('createdAt').get(),
    db.collection('archive').doc(archId).collection('history').orderBy('createdAt','desc').get()
  ]);
  const comments = csSnap.docs.map(d=>d.data());
  const history = hsSnap.docs.map(d=>d.data());

  modal.innerHTML = `
    <div class="mhdr">
      <div style="flex:1">
        <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
          <span class="pbadge ${a.priority}">${a.priority||''}</span>
          <span style="font-size:11px;background:#f1f5f9;color:#475569;padding:2px 8px;border-radius:4px;font-weight:600">${trackName}</span>
          ${inst?`<span style="font-size:11px;background:#f0fdf4;color:#15803d;padding:2px 8px;border-radius:4px;font-weight:700;font-family:monospace">${esc(inst)}</span>`:''}
          <span style="font-size:11px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-weight:700">ARCHIVED</span>
        </div>
        <div class="mtitle">${esc(a.title||'')}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px">
          Board: ${esc(board?board.title:'(deleted)')} · Logged by ${esc(a.createdBy||'?')} · ${fmtTime(a.createdAt)} · Archived ${fmtTime(a.archivedAt)}
        </div>
      </div>
      <button class="mclose" onclick="closeDetail()">×</button>
    </div>

    <div class="dbody">
      <div>
        <div class="sec-lbl">Description</div>
        <div class="desc-box">${a.description ? esc(a.description) : '<span style="color:#94a3b8">No description.</span>'}</div>

        ${a.fixDescription ? `
        <div class="fix-box">
          <div class="fix-box-lbl">How it was fixed</div>
          <div class="fix-box-text">${esc(a.fixDescription)}</div>
          <div class="fix-box-meta">Fixed by ${esc(a.fixedBy||'?')} · ${fmtTime(a.fixedAt)}</div>
        </div>
        ` : `
        <div class="fix-box" style="border-style:dashed;background:transparent;opacity:.6">
          <div class="fix-box-lbl">How it was fixed</div>
          <div class="fix-box-text" style="color:var(--muted)">No fix description was recorded for this issue.</div>
        </div>
        `}

        <div class="sec-lbl" style="margin-bottom:9px">Comments (${comments.length})</div>
        <div class="clist">
          ${comments.length ? comments.map(c=>`<div class="ci">
            <div class="ci-author">${esc(c.author)} <span style="font-weight:400;color:var(--muted)">(${c.role||''})</span></div>
            <div class="ci-text">${parseMentions(c.text||'')}</div>
            <div class="ci-time">${fmtTime(c.createdAt)}</div>
          </div>`).join('') : '<div style="color:#94a3b8;font-size:13px">No comments.</div>'}
        </div>

        ${history.length ? `<div class="sec-lbl" style="margin-top:18px;margin-bottom:9px">History</div>
          <div>${history.map(h=>`<div class="h-entry">${describeActivity(h)} <span class="h-time">· ${fmtTime(h.createdAt)}</span></div>`).join('')}</div>` : ''}
      </div>

      <div class="sidebar">
        <div class="sb-sec"><div class="sb-lbl">Final Status</div><div class="sb-val">Resolved</div></div>
        <div class="sb-sec"><div class="sb-lbl">Priority</div><div class="sb-val">${PRIORITY_LABELS[a.priority]||a.priority||''}</div></div>
        <div class="sb-sec"><div class="sb-lbl">Resolved By</div><div class="sb-val">${esc(a.assignee||'Unassigned')}</div></div>
        <div class="sb-sec"><div class="sb-lbl">Track</div><div class="sb-val">${trackName}</div></div>
        ${inst?`<div class="sb-sec"><div class="sb-lbl">Instrument</div><div class="sb-val" style="font-family:monospace">${esc(inst)}</div></div>`:''}
      </div>
    </div>
  `;
  document.getElementById('detailOverlay').classList.remove('hidden');
}

// ── STATS DASHBOARD ───────────────────────────────────────────
// Aggregate metrics computed client-side from the archive. Includes
// most problematic instruments, average resolution time per priority,
// issues by role, issues by track, and recurring problems (titles
// matched 3+ times). Rebuilds on every dashboard open; volumes are
// small enough that pre-aggregation is unnecessary.
let statsCache = {issues:[], archive:[]};

async function openStats(){
  document.getElementById('statsPanel').classList.add('open');
  updateHeaderActiveStates();
  // Load both active and archived for stats
  const [activeSnap, archSnap] = await Promise.all([
    db.collection('issues').get(),
    db.collection('archive').get()
  ]);
  statsCache.issues = activeSnap.docs.map(d=>({id:d.id, ...d.data()}));
  statsCache.archive = archSnap.docs.map(d=>({id:d.id, ...d.data()}));
  renderStats();
}

function closeStats(){
  document.getElementById('statsPanel').classList.remove('open');
  updateHeaderActiveStates();
}

function renderStats(){
  const days = parseInt(document.getElementById('statsRange').value, 10);
  const cutoff = Date.now() - days*24*60*60*1000;
  const all = [...statsCache.issues, ...statsCache.archive].filter(i=>{
    const ts = i.createdAt?.toMillis ? i.createdAt.toMillis() : 0;
    return ts >= cutoff;
  });

  // Most problematic instruments
  const instCounts = {};
  all.forEach(i=>{
    if(!i.instrumentType) return;
    instCounts[i.instrumentType] = (instCounts[i.instrumentType]||0) + 1;
  });
  const topInst = Object.entries(instCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxInst = topInst[0] ? topInst[0][1] : 1;

  // Average resolution time per priority (resolved/archived only)
  const resByPri = {critical:[], urgent:[], moderate:[], low:[]};
  all.forEach(i=>{
    if(i.status!=='resolved' && !i.archivedAt) return;
    const created = i.createdAt?.toMillis ? i.createdAt.toMillis() : 0;
    const resolvedTs = i.archivedAt?.toMillis ? i.archivedAt.toMillis() : (i.updatedAt?.toMillis ? i.updatedAt.toMillis() : 0);
    if(!created || !resolvedTs) return;
    const ms = resolvedTs - created;
    if(resByPri[i.priority]) resByPri[i.priority].push(ms);
  });
  const avgResHtml = ['critical','urgent','moderate','low'].map(p=>{
    const arr = resByPri[p];
    if(!arr.length) return `<div class="bar-row"><span class="bar-label">${PRIORITY_LABELS[p]}</span><span style="color:var(--muted);font-size:12px">No data</span></div>`;
    const avg = arr.reduce((a,b)=>a+b,0)/arr.length;
    return `<div class="bar-row"><span class="bar-label">${PRIORITY_LABELS[p]}</span><span style="font-size:12px">${fmtDuration(avg)} <span style="color:var(--muted)">(${arr.length})</span></span></div>`;
  }).join('');

  // Issues per role
  const roleCounts = {ALO:0, Siemens:0, Lead:0};
  all.forEach(i=>{
    if(!i.assignee) return;
    const r = roster.find(x=>x.name===i.assignee);
    if(r && roleCounts[r.role]!==undefined) roleCounts[r.role]++;
  });
  const totalRole = Object.values(roleCounts).reduce((a,b)=>a+b,0) || 1;

  // By track
  const trackCounts = {op:0, bb:0, general:0};
  all.forEach(i=>{
    if(trackCounts[i.track]!==undefined) trackCounts[i.track]++;
  });

  // Recurring problems: same instrument + unit + track appearing 3+ times.
  // Track is included so OP and BB issues on the same unit are counted
  // separately (BIM 1 OP and BIM 1 BB are different patterns). General
  // track issues are not side-specific so track is omitted for those.
  const recurMap = {};
  all.forEach(i=>{
    if(!i.instrumentType) return;
    const parts = [i.instrumentType, i.unitNumber||''];
    if(i.track && i.track !== 'general') parts.push(i.track.toUpperCase());
    const key = parts.filter(Boolean).join(' ');
    recurMap[key] = (recurMap[key]||0)+1;
  });
  const recurring = Object.entries(recurMap).filter(([k,v])=>v>=3).sort((a,b)=>b[1]-a[1]);

  document.getElementById('statsBody').innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-card-title">Total Issues</div>
        <div class="stat-big">${all.length}</div>
        <div class="stat-sub">in last ${days} days</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-title">Most Problematic Instruments</div>
        ${topInst.length ? topInst.map(([n,c])=>`
          <div class="bar-row">
            <span class="bar-label">${esc(n)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(c/maxInst)*100}%"></div></div>
            <span class="bar-cnt">${c}</span>
          </div>`).join('') : '<div style="color:var(--muted);font-size:13px">No data yet</div>'}
      </div>
      <div class="stat-card">
        <div class="stat-card-title">Avg Resolution Time</div>
        ${avgResHtml}
      </div>
      <div class="stat-card">
        <div class="stat-card-title">Issues by Role</div>
        ${ROLE_ORDER.map(r=>`
          <div class="bar-row">
            <span class="bar-label">${ROLE_LABELS[r]}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(roleCounts[r]/totalRole)*100}%"></div></div>
            <span class="bar-cnt">${roleCounts[r]}</span>
          </div>`).join('')}
      </div>
      <div class="stat-card">
        <div class="stat-card-title">By Track</div>
        <div class="bar-row"><span class="bar-label">OP</span><div class="bar-track"><div class="bar-fill" style="width:${(trackCounts.op/(all.length||1))*100}%;background:var(--op)"></div></div><span class="bar-cnt">${trackCounts.op}</span></div>
        <div class="bar-row"><span class="bar-label">BB</span><div class="bar-track"><div class="bar-fill" style="width:${(trackCounts.bb/(all.length||1))*100}%;background:var(--bb)"></div></div><span class="bar-cnt">${trackCounts.bb}</span></div>
        <div class="bar-row"><span class="bar-label">General</span><div class="bar-track"><div class="bar-fill" style="width:${(trackCounts.general/(all.length||1))*100}%;background:#94a3b8"></div></div><span class="bar-cnt">${trackCounts.general}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-card-title">Recurring Problems (3+)</div>
        ${recurring.length ? `<div class="recur-list">${recurring.map(([k,v])=>`
          <div class="recur-item"><span class="recur-name">${esc(k)}</span><span class="recur-cnt">${v}×</span></div>
        `).join('')}</div>` : '<div style="color:var(--muted);font-size:13px">No recurring patterns yet</div>'}
      </div>
    </div>
  `;
}

function fmtDuration(ms){
  if(!ms || ms<0) return 'N/A';
  const mins = Math.round(ms/60000);
  if(mins < 60) return `${mins}m`;
  const hrs = mins/60;
  if(hrs < 24) return `${hrs.toFixed(1)}h`;
  return `${(hrs/24).toFixed(1)}d`;
}

// ── CSV EXPORT ────────────────────────────────────────────────
// Generates downloadable CSV from the archive viewer or stats
// dashboard. Builds the file in memory as a string and triggers a
// download via a synthesized anchor element with a blob URL.
function csvEscape(v){
  if(v===null || v===undefined) return '';
  const s = String(v);
  if(/[",\n\r]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}

function exportCSV(source){
  let rows = [];
  let filename = 'labtrack-export.csv';

  if(source==='archive'){
    const wk = document.getElementById('archWeek').value;
    const bd = document.getElementById('archBoard').value;
    const term = (document.getElementById('archSearch').value||'').toLowerCase().trim();
    let items = archiveData;
    if(wk) items = items.filter(a=>String(a.weekBucket)===wk);
    if(bd) items = items.filter(a=>a.boardId===bd);
    if(term){
      items = items.filter(a=>{
        const hay = `${a.title||''} ${a.description||''} ${a.instrumentType||''} ${a.unitNumber||''} ${a.assignee||''} ${a.createdBy||''} ${a.fixDescription||''}`.toLowerCase();
        return hay.includes(term);
      });
    }
    rows = items;
    filename = `labtrack-archive-${new Date().toISOString().slice(0,10)}.csv`;
  } else {
    // Stats source = all issues + archive in current range
    const days = parseInt(document.getElementById('statsRange').value, 10);
    const cutoff = Date.now() - days*24*60*60*1000;
    rows = [...statsCache.issues, ...statsCache.archive].filter(i=>{
      const ts = i.createdAt?.toMillis ? i.createdAt.toMillis() : 0;
      return ts >= cutoff;
    });
    filename = `labtrack-stats-${days}d-${new Date().toISOString().slice(0,10)}.csv`;
  }

  if(!rows.length){
    showToast('Nothing to export.');
    return;
  }

  const headers = ['Title','Description','Priority','Status','Track','Instrument','Unit','Assignee','Created By','Created At','Updated At','Resolved/Archived At','Comments'];
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach(r=>{
    const board = boards.find(b=>b.id===r.boardId);
    const resolvedAt = r.archivedAt?.toDate ? r.archivedAt.toDate().toISOString() :
                      (r.status==='resolved' && r.updatedAt?.toDate ? r.updatedAt.toDate().toISOString() : '');
    lines.push([
      r.title||'',
      r.description||'',
      r.priority||'',
      r.archivedAt ? 'archived' : (r.status||''),
      r.track||'',
      r.instrumentType||'',
      r.unitNumber||'',
      r.assignee||'',
      r.createdBy||'',
      r.createdAt?.toDate ? r.createdAt.toDate().toISOString() : '',
      r.updatedAt?.toDate ? r.updatedAt.toDate().toISOString() : '',
      resolvedAt,
      r.commentCount||0
    ].map(csvEscape).join(','));
  });

  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Exported ${rows.length} row(s).`);
}

// ── BUNCH 5: REPORTS / LINE STATUS ─────────────────────────────
// Reports panel and Line Status form builder. The Reports panel hosts
// three tabs: Line Status (this section), Saved Snapshots, and EOD.
// Line Status accepts FlexLab CSV exports for OP and BB, processes
// them into a formatted hourly summary table, and combines that with
// a structured form for all the supporting fields (buckets, OOS
// analyzers, overloads, BIM read rates, startup times, unpacking,
// and BB/OP notes). The output renders as fully inline-styled HTML
// for clean copy-paste into Outlook.
// Configuration: instrument lists per cell, ranges, etc.
const LS_OOS_OPTIONS = {
  bb_hemo: [...range(201,221), 223].map(n=>'ADV'+n),
  bb_special: ['ASH201', ...range(26,29).map(n=>'BASH'+n)],
  bb_auto: range(20,25).map(n=>'BASH'+n),
  op_hemo: range(101,121).map(n=>'ADV'+n),
  op_special: range(16,19).map(n=>'BASH'+n),
  op_auto: range(10,15).map(n=>'BASH'+n)
};
function range(a,b){const arr=[];for(let i=a;i<=b;i++)arr.push(i);return arr;}

// 30-min time slots from 00:00 to 23:30
const LS_TIME_SLOTS = (()=>{
  const out=[]; for(let h=0;h<24;h++){for(const m of ['00','30']) out.push(`${String(h).padStart(2,'0')}:${m}`);} return out;
})();

// Bucket count options 0 to 300 (single increments)
const LS_BUCKET_COUNTS = range(0,300);
// Pending relabel 0 to 15
const LS_RELABEL_COUNTS = range(0,15);
// Overload values: N/A or 0 to 725 in steps of 5
const LS_OVERLOAD_VALS = ['N/A', ...range(0,145).map(n=>n*5+'/725')];

// CSV processing, adapted from the original Automated Line Status script
const LS_CSV_OP_TAG = '191';
const LS_CSV_BB_TAG = '192';

let lsState = {
  date: '',
  projected: '',
  csvOp: null,        // {file, rows: [[time, first, second, total]]}
  csvBb: null,
  bucketCount: '',
  bucketTime: '',
  bucketNotes: '',
  relabelBb: '',
  relabelOp: '',
  oos: {bb_hemo:[], bb_special:[], bb_auto:[], op_hemo:[], op_special:[], op_auto:[]},
  oosNotes: {bb_hemo:'', bb_special:'', bb_auto:'', op_hemo:'', op_special:'', op_auto:''},
  overloads: {bb_hemo:'', bb_special:'', bb_auto:'', op_hemo:'', op_special:'', op_auto:''},
  overloadNotes: '',
  bim: {bb:Array(10).fill(''), op:Array(10).fill('')},  // 1-8 + IOM 1 + IOM 2
  startup: [
    {dept:'Hematology', bb:'', op:'', full:false, partial:false},
    {dept:'A1Cs Atellica', bb:'', op:'', full:false, partial:false},
    {dept:'IM Atellicas', bb:'', op:'', full:false, partial:false},
    {dept:'CHE Atellicas', bb:'', op:'', full:false, partial:false}
  ],
  unpacking: {ongoing:false, completed:false, lh_flx:false, lh_fedex:false, lh_ups:false, lh_wc:false},
  bbNotes: '',
  opNotes: '',
  isFinal: false,
  deletedSlots: [],
  romNotes: {}
};

let currentReportTab = 'ls';

function openReports(){
  document.getElementById('reportsPanel').classList.add('open');
  updateHeaderActiveStates();
  // Restore saved projected if any
  const savedProj = localStorage.getItem('lt_lsProjected');
  if(savedProj && !lsState.projected) lsState.projected = savedProj;
  // Default date if blank
  if(!lsState.date) lsState.date = formatTodayLong();
  switchReportTab(currentReportTab);
}

function closeReports(){
  document.getElementById('reportsPanel').classList.remove('open');
  updateHeaderActiveStates();
}

function switchReportTab(tab){
  currentReportTab = tab;
  document.getElementById('rTabLs').classList.toggle('active', tab==='ls');
  document.getElementById('rTabSnap').classList.toggle('active', tab==='snap');
  document.getElementById('rTabEod').classList.toggle('active', tab==='eod');
  document.getElementById('rTabLsArch').classList.toggle('active', tab==='lsarch');
  if(tab==='ls') renderLineStatus();
  else if(tab==='snap') renderSnapshots();
  else if(tab==='eod') renderEOD();
  else if(tab==='lsarch') renderLsArchive();
}

function formatTodayLong(){
  const d = new Date();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day = d.getDate();
  const suffix = (n=>{ if(n>=11&&n<=13) return 'th'; const s=n%10; return s===1?'st':s===2?'nd':s===3?'rd':'th'; })(day);
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

// Render the full Line Status form + preview
function renderLineStatus(){
  const body = document.getElementById('reportsBody');
  body.innerHTML = `
    <div class="reports-split">
      <div class="ls-form">
        <div class="ls-section">
          <div class="ls-sec-title">CSV Files</div>
          <div class="ls-csv-zone" id="lsCsvZone" tabindex="0">
            Drag &amp; drop CSV files here, or click to select
          </div>
          <div class="ls-csv-files" id="lsCsvFiles"></div>
          <div class="ls-row" style="margin-top:10px">
            <span class="ls-lbl">Projected:</span>
            <input class="ls-mini w90" id="lsProjected" type="number" placeholder="e.g. 110890" value="${esc(lsState.projected)}" oninput="lsUpdate('projected',this.value)" />
            <span class="ls-lbl">Date:</span>
            <input class="ls-mini" style="flex:1" id="lsDate" value="${esc(lsState.date)}" oninput="lsUpdate('date',this.value)" />
          </div>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Unpacking / Shipments</div>
          <table class="ls-unpack-tbl">
            <thead>
              <tr><th rowspan="2" style="width:90px">Unpacking</th><th>Ongoing</th><th>Completed</th></tr>
              <tr>
                <td><div class="ls-x-cell ${lsState.unpacking.ongoing?'checked':''}" onclick="lsToggleUnpack('ongoing')">${lsState.unpacking.ongoing?'X':''}</div></td>
                <td><div class="ls-x-cell ${lsState.unpacking.completed?'checked':''}" onclick="lsToggleUnpack('completed')">${lsState.unpacking.completed?'X':''}</div></td>
              </tr>
              <tr><th style="width:90px">Line Haul</th><th>FLX</th><th>FedEx</th><th>UPS</th><th>WC</th></tr>
              <tr>
                <td></td>
                <td><div class="ls-x-cell ${lsState.unpacking.lh_flx?'checked':''}" onclick="lsToggleUnpack('lh_flx')">${lsState.unpacking.lh_flx?'X':''}</div></td>
                <td><div class="ls-x-cell ${lsState.unpacking.lh_fedex?'checked':''}" onclick="lsToggleUnpack('lh_fedex')">${lsState.unpacking.lh_fedex?'X':''}</div></td>
                <td><div class="ls-x-cell ${lsState.unpacking.lh_ups?'checked':''}" onclick="lsToggleUnpack('lh_ups')">${lsState.unpacking.lh_ups?'X':''}</div></td>
                <td><div class="ls-x-cell ${lsState.unpacking.lh_wc?'checked':''}" onclick="lsToggleUnpack('lh_wc')">${lsState.unpacking.lh_wc?'X':''}</div></td>
              </tr>
            </thead>
          </table>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
            BB / OP Notes
            <div style="margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <select class="ls-mini" style="font-size:11px" onchange="lsSourceBoard=this.value||null">
                <option value="">Current board</option>
                ${boards.map(b=>`<option value="${b.id}" ${lsSourceBoard===b.id?'selected':''}>${esc(b.title)}</option>`).join('')}
              </select>
              <button class="ls-add-btn" style="font-size:11px;padding:3px 9px" onclick="lsRefreshNotes()">Refresh from Board</button>
              ${tt('Pulls open issues from the selected board and fills in the BB and OP notes fields. Pick a board from the dropdown first if you want to pull from something other than the one you are currently viewing. You can edit the result after it populates.')}
            </div>
          </div>
          <div class="ls-cell-hdr bb" style="margin-top:5px">BB</div>
          <textarea class="ls-textarea" placeholder="One issue per line (will render as bullets)" oninput="lsUpdate('bbNotes',this.value)">${esc(lsState.bbNotes)}</textarea>
          <div class="ls-cell-hdr op" style="margin-top:8px">OP</div>
          <textarea class="ls-textarea" placeholder="One issue per line (will render as bullets)" oninput="lsUpdate('opNotes',this.value)">${esc(lsState.opNotes)}</textarea>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Startup Times</div>
          <table class="ls-startup-tbl">
            <thead>
              <tr><th>Dept/Module</th><th style="color:var(--bb)">BB</th><th style="color:var(--op)">OP</th><th>Full</th><th>Partial</th></tr>
            </thead>
            <tbody>
              ${lsState.startup.map((r,i)=>`
                <tr>
                  <td style="text-align:left;font-weight:600">${esc(r.dept)}:</td>
                  <td><input class="ls-mini" list="dl_startupTime" value="${esc(r.bb)}" placeholder="--:--" oninput="lsUpdateStartup(${i},'bb',this.value)" autocomplete="off" /></td>
                  <td><input class="ls-mini" list="dl_startupTime" value="${esc(r.op)}" placeholder="--:--" oninput="lsUpdateStartup(${i},'op',this.value)" autocomplete="off" /></td>
                  <td><div class="ls-x-cell ${r.full?'checked':''}" onclick="lsToggleStartup(${i},'full')">${r.full?'X':''}</div></td>
                  <td><div class="ls-x-cell ${r.partial?'checked':''}" onclick="lsToggleStartup(${i},'partial')">${r.partial?'X':''}</div></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <datalist id="dl_startupTime">${LS_TIME_SLOTS.map(t=>`<option value="${t}">`).join('')}</datalist>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Buckets to Load</div>
          <div class="ls-row">
            ${comboInput('dl_bucketCount', LS_BUCKET_COUNTS, lsState.bucketCount, "lsUpdate('bucketCount',this.value)", 'w70')}
            <span>@</span>
            ${comboInput('dl_bucketTime', LS_TIME_SLOTS, lsState.bucketTime, "lsUpdate('bucketTime',this.value)", 'w90')}
          </div>
          <textarea class="ls-textarea" placeholder="Optional notes (e.g. '3 Buckets of sorted HEMO')" oninput="lsUpdate('bucketNotes',this.value)" style="margin-top:8px">${esc(lsState.bucketNotes)}</textarea>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Pending Buckets to Relabel</div>
          <div class="ls-grid ls-grid-2">
            <div class="ls-cell">
              <div class="ls-cell-hdr bb">BB</div>
              ${comboInput('dl_relabelBb', LS_RELABEL_COUNTS, lsState.relabelBb, "lsUpdate('relabelBb',this.value)")}
            </div>
            <div class="ls-cell">
              <div class="ls-cell-hdr op">OP</div>
              ${comboInput('dl_relabelOp', LS_RELABEL_COUNTS, lsState.relabelOp, "lsUpdate('relabelOp',this.value)")}
            </div>
          </div>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">OOS Analyzers</div>
          ${['bb','op'].map(t=>`
            <div class="ls-cell-hdr ${t}" style="margin-top:${t==='op'?'10px':'0'}">${t.toUpperCase()}</div>
            <div class="ls-grid" style="grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:5px">
              ${['hemo','special','auto'].map(d=>{
                const key = `${t}_${d}`;
                return `<div class="ls-cell">
                  <div style="font-size:10px;font-weight:700;color:var(--muted)">${d.toUpperCase()}</div>
                  <div class="ls-tag-list" id="oosTags_${key}">${renderOosTags(key)}</div>
                  <div class="ls-add-row">
                    <select class="ls-mini" id="oosSel_${key}">
                      <option value="">add...</option>
                      ${LS_OOS_OPTIONS[key].filter(o=>!lsState.oos[key].includes(o)).map(o=>`<option value="${o}">${o}</option>`).join('')}
                    </select>
                    <button class="ls-add-btn" onclick="lsAddOos('${key}')">+</button>
                  </div>
                  <input class="ls-mini" placeholder="custom..." onkeydown="if(event.key==='Enter'){lsAddOosCustom('${key}',this.value);this.value=''}" style="margin-top:4px;width:100%" />
                </div>`;
              }).join('')}
            </div>
          `).join('')}
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Overloads / Buffer Status</div>
          ${['bb','op'].map(t=>`
            <div class="ls-cell-hdr ${t}" style="margin-top:${t==='op'?'10px':'0'}">${t.toUpperCase()}</div>
            <div class="ls-grid" style="grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:5px">
              ${['hemo','special','auto'].map(d=>{
                const key = `${t}_${d}`;
                return `<div class="ls-cell">
                  <div style="font-size:10px;font-weight:700;color:var(--muted)">${d.toUpperCase()}</div>
                  ${comboInput('dl_ovl_'+key, LS_OVERLOAD_VALS, lsState.overloads[key]||'', "lsUpdateNested('overloads','"+key+"',this.value)")}
                </div>`;
              }).join('')}
            </div>
          `).join('')}
          <textarea class="ls-textarea" placeholder="Additional overload notes (optional)" oninput="lsUpdate('overloadNotes',this.value)" style="margin-top:8px">${esc(lsState.overloadNotes)}</textarea>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">BIM Read Rates</div>
          <div class="ls-bim-grid">
            ${['bb','op'].map(t=>`
              <div class="ls-bim-col">
                <div class="ls-cell-hdr ${t}">${t.toUpperCase()} % Success</div>
                ${['1','2','3','4','5','6','7','8','IOM 1','IOM 2'].map((lbl,i)=>`
                  <div class="ls-bim-row">
                    <span class="lbl">${lbl}</span>
                    <input value="${esc(lsState.bim[t][i])}" oninput="lsUpdateBim('${t}',${i},this.value)" placeholder="-" />
                  </div>
                `).join('')}
              </div>
            `).join('')}
          </div>
        </div>

        <div class="ls-actions">
          <button class="btn-clear" onclick="lsClear()">Clear All</button>
          <span class="tt-wrap tt-flip">
            <button class="btn-snap" onclick="lsSaveSnapshot()">Save Snapshot</button>
            <button class="tt-btn" type="button" onclick="ttToggle(event)" aria-label="More information">?</button>
            <span class="tt-box">Saves a draft of this form so you can reload it later from the Saved Snapshots tab.</span>
          </span>
          <span class="tt-wrap tt-flip">
            <button class="btn-copy" onclick="lsCopy()">Copy to Clipboard</button>
            <button class="tt-btn" type="button" onclick="ttToggle(event)" aria-label="More information">?</button>
            <span class="tt-box">Copies the formatted report so you can paste it directly into an Outlook email. Tables and layout are preserved on paste.</span>
          </span>
          <label class="ls-final-toggle" title="Mark this as the last Line Status of the shift. Final line statuses are stored permanently in the LS Archive tab.">
            <input type="checkbox" id="lsFinalCheck" ${lsState.isFinal?'checked':''} onchange="lsUpdate('isFinal',this.checked)">
            Final
          </label>
          <span class="tt-wrap tt-flip">
            <button class="btn-publish ${lsState.isFinal?'btn-publish-final':''}" onclick="lsPublish()" title="Publish this report so the team can view it under the Today tab">
              ${lsState.isFinal ? 'Publish Final' : 'Publish'}
            </button>
            <button class="tt-btn" type="button" onclick="ttToggle(event)" aria-label="More information">?</button>
            <span class="tt-box">Posts the current report to the Today tab where the whole team can see it in real time. If Final is checked, it is also saved permanently to the LS Archive.</span>
          </span>
        </div>
      </div>

      <div class="ls-preview">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Live Preview</div>
        <div class="ls-render" id="lsRender">${renderLsHTML()}</div>
      </div>
    </div>
  `;
  wireCsvZone();
}

// Helper: render <option> list
function optList(arr, selected){
  return arr.map(v=>`<option value="${v}" ${String(selected)===String(v)?'selected':''}>${v}</option>`).join('');
}

// Renders an <input> + <datalist> combo so the user can either pick
// from the list or type freely. The datalist filters as the user types.
// listId must be unique per field instance. val is the current value.
// onInput is the JS string to call on input (e.g. "lsUpdate('x',this.value)").
// cls is an optional extra CSS class string.
function comboInput(listId, options, val, onInput, cls){
  const opts = options.map(o=>`<option value="${o}">`).join('');
  return `<input class="ls-mini${cls?' '+cls:''}" list="${listId}" value="${esc(String(val??''))}" oninput="${onInput}" placeholder="--" autocomplete="off"><datalist id="${listId}">${opts}</datalist>`;
}

function renderOosTags(key){
  return lsState.oos[key].map(v=>`<span class="ls-tag">${esc(v)}<span class="ls-tag-x" onclick="lsRemoveOos('${key}','${esc(v)}')">×</span></span>`).join('') || '<span style="color:var(--muted);font-size:11px">none</span>';
}

// State updaters
function lsUpdate(field, value){
  lsState[field] = value;
  if(field==='projected') localStorage.setItem('lt_lsProjected', value);
  refreshPreview();
}
function lsUpdateNested(parent, key, value){
  lsState[parent][key] = value;
  refreshPreview();
}
function lsUpdateBim(track, idx, value){
  lsState.bim[track][idx] = value;
  refreshPreview();
}
function lsUpdateStartup(idx, field, value){
  lsState.startup[idx][field] = value;
  refreshPreview();
}
// Toggles a boolean cell in the Startup Times grid (Full or Partial
// columns). Triggers a full form re-render rather than just a preview
// refresh because the cell's visual state is part of the form itself.
function lsToggleStartup(idx, field){
  lsState.startup[idx][field] = !lsState.startup[idx][field];
  renderLineStatus();
}
function lsToggleUnpack(field){
  lsState.unpacking[field] = !lsState.unpacking[field];
  renderLineStatus();
}
function lsAddOos(key){
  const sel = document.getElementById('oosSel_'+key);
  if(sel?.value && !lsState.oos[key].includes(sel.value)){
    lsState.oos[key].push(sel.value);
    renderLineStatus();
  }
}
function lsAddOosCustom(key, value){
  const v = value.trim();
  if(v && !lsState.oos[key].includes(v)){
    lsState.oos[key].push(v);
    renderLineStatus();
  }
}
function lsRemoveOos(key, value){
  lsState.oos[key] = lsState.oos[key].filter(v=>v!==value);
  renderLineStatus();
}

// Auto-pull notes from active LabTrack issues
function lsRefreshNotes(){
  const sourceBid = lsSourceBoard || boardId;
  const activeIssues = issues.filter(i=>i.boardId===sourceBid && i.status!=='resolved');
  const bbItems = activeIssues.filter(i=>i.track==='bb').map(i=>{
    const inst = [i.instrumentType,i.unitNumber].filter(Boolean).join(' ');
    return inst ? `${inst}: ${i.title}` : i.title;
  });
  const opItems = activeIssues.filter(i=>i.track==='op').map(i=>{
    const inst = [i.instrumentType,i.unitNumber].filter(Boolean).join(' ');
    return inst ? `${inst}: ${i.title}` : i.title;
  });
  lsState.bbNotes = bbItems.join('\n');
  lsState.opNotes = opItems.join('\n');
  renderLineStatus();
  const boardName = boards.find(b=>b.id===sourceBid)?.title || 'current board';
  showToast(`Notes refreshed from "${boardName}".`);
}

// Refreshes only the live preview pane without re-rendering the full
// form. This is important because re-rendering the form would blur any
// active textarea or select element, interrupting the user mid-typing.
// Field-level updates therefore call refreshPreview() while toggle
// interactions (X buttons, etc.) call the full renderLineStatus().
// Deletes a single time slot from the final table in the preview.
function lsDeleteSlot(time){
  if(!lsState.deletedSlots) lsState.deletedSlots = [];
  lsState.deletedSlots.push(time);
  refreshPreview();
}

// Sets the ROM note for a specific time slot.
function lsSetRom(time, val){
  if(!lsState.romNotes) lsState.romNotes = {};
  lsState.romNotes[time] = val;
  // No full re-render: the input is live in the DOM already.
}

// Refreshes only the live preview pane without re-rendering the full
// form. This is important because re-rendering the form would blur any
// active textarea or select element, interrupting the user mid-typing.
// Field-level updates therefore call refreshPreview() while toggle
// interactions (X buttons, etc.) call the full renderLineStatus().
function refreshPreview(){
  const el = document.getElementById('lsRender');
  if(!el) return;
  const final = lsBuildFinalTable();
  const deleted = new Set(lsState.deletedSlots || []);
  const fmt = n => typeof n === 'number' ? n.toLocaleString() : (n||'');

  if(!final){
    // No CSV data yet: fall back to full copy render (shows the placeholder text)
    el.innerHTML = renderLsHTML();
    return;
  }

  // Render the interactive top table, then append the rest of the
  // sections from renderLsHTML() by stripping the first table out of it.
  // This avoids any shared-function complexity: lsCopy() always calls
  // renderLsHTML() directly; the preview adds controls on top.
  let tableHtml = `<table class="ls-preview-tbl"><thead><tr>
    <th class="lsp-del-col"></th>
    <th class="lsp-time">Time</th>
    <th class="lsp-bb">BB Total</th>
    <th class="lsp-op">OP Total</th>
    <th>Hourly Total</th>
    <th>Running Total</th>
    <th>Proj. Remaining</th>
    <th>Projected</th>
    <th class="lsp-rom-hdr">ROM Samples</th>
  </tr></thead><tbody>`;

  final.forEach(r => {
    if(deleted.has(r.time)) return;
    const rom = (lsState.romNotes||{})[r.time] || '';
    const projVal = fmt(r.projected);
    tableHtml += `<tr class="lsp-row">
      <td class="lsp-del-col"><button class="lsp-del-btn" onclick="lsDeleteSlot('${r.time.replace(/'/g,"\\'")}')">×</button></td>
      <td class="lsp-time"><b>${esc(r.time)}</b></td>
      <td class="lsp-bb">${fmt(r.bb)}</td>
      <td class="lsp-op">${fmt(r.op)}</td>
      <td>${fmt(r.hourly)}</td>
      <td>${fmt(r.running)}</td>
      <td>${fmt(r.remaining)}</td>
      <td>${projVal}</td>
      <td class="lsp-rom-cell"><input class="lsp-rom-input${rom?' has-value':''}" type="text" value="${esc(rom)}" placeholder="ROM Samples..." oninput="lsSetRom('${r.time.replace(/'/g,"\\'")}',this.value);this.classList.toggle('has-value',this.value.length>0)"></td>
    </tr>`;
  });

  tableHtml += `</tbody></table>`;

  // Strip the copy-ready top table from renderLsHTML() output and append
  // everything after it (notes, startup, buckets, etc.)
  const copyHtml = renderLsHTML();
  const afterTable = copyHtml.replace(/^[\s\S]*?<\/table>/, '').replace(/^<div[^>]*>&nbsp;<\/div>/, '');
  el.innerHTML = tableHtml + afterTable;
}

function lsClear(){
  if(!confirm('Clear all Line Status fields? CSV files will also be removed.')) return;
  const keepProjected = lsState.projected;
  lsState = {
    date: formatTodayLong(),
    projected: keepProjected,
    csvOp: null, csvBb: null,
    bucketCount:'', bucketTime:'', bucketNotes:'',
    relabelBb:'', relabelOp:'',
    oos: {bb_hemo:[], bb_special:[], bb_auto:[], op_hemo:[], op_special:[], op_auto:[]},
    oosNotes: {bb_hemo:'', bb_special:'', bb_auto:'', op_hemo:'', op_special:'', op_auto:''},
    overloads: {bb_hemo:'', bb_special:'', bb_auto:'', op_hemo:'', op_special:'', op_auto:''},
    overloadNotes:'',
    bim: {bb:Array(10).fill(''), op:Array(10).fill('')},
    startup: [
      {dept:'Hematology', bb:'', op:'', full:false, partial:false},
      {dept:'A1Cs Atellica', bb:'', op:'', full:false, partial:false},
      {dept:'IM Atellicas', bb:'', op:'', full:false, partial:false},
      {dept:'CHE Atellicas', bb:'', op:'', full:false, partial:false}
    ],
    unpacking: {ongoing:false, completed:false, lh_flx:false, lh_fedex:false, lh_ups:false, lh_wc:false},
    bbNotes:'', opNotes:'',
    isFinal: false,
    deletedSlots: [],
    romNotes: {}
  };
  renderLineStatus();
  showToast('Line Status cleared.');
}

// ── CSV PROCESSING (adapted from original Automated Line Status) ─────
// CSV ingest pipeline ported from the team's standalone Automated Line
// Status tool. Each FlexLab export contains 30-minute count buckets;
// these are aggregated into hourly totals (first half + second half =
// hourly), then merged across both files into the final summary table
// with running totals and projected remaining. Shift-start hour is
// inferred by finding the rotation that produces the longest run of
// consecutive hours, which correctly handles night shifts that cross
// midnight.
function wireCsvZone(){
  const zone = document.getElementById('lsCsvZone');
  if(!zone) return;
  zone.onclick = ()=>{
    const inp = document.createElement('input');
    inp.type='file'; inp.accept='.csv'; inp.multiple=true;
    inp.onchange = ()=>{ if(inp.files?.length) lsHandleCsvFiles(Array.from(inp.files)); };
    inp.click();
  };
  zone.ondragover = e=>{ e.preventDefault(); zone.classList.add('drag'); };
  zone.ondragleave = e=>{ e.preventDefault(); zone.classList.remove('drag'); };
  zone.ondrop = e=>{
    e.preventDefault(); zone.classList.remove('drag');
    if(e.dataTransfer.files?.length) lsHandleCsvFiles(Array.from(e.dataTransfer.files));
  };
  renderCsvFiles();
}

// Accepts dropped or selected CSV files and routes each to the
// correct slot (OP or BB) based on the FlexLab analyzer ID embedded
// in the filename: 191 indicates Optimus Prime, 192 indicates
// Bumblebee. Files that match neither are skipped with a toast.
// Successfully parsed rows are aggregated into hourly buckets via
// lsProcessCsvRows() before being attached to lsState.
async function lsHandleCsvFiles(files){
  for(const f of files){
    if(!f.name.toLowerCase().endsWith('.csv')){
      showToast(`Skipped ${f.name} (not CSV)`);
      continue;
    }
    const which = f.name.includes(LS_CSV_OP_TAG) ? 'op' : f.name.includes(LS_CSV_BB_TAG) ? 'bb' : null;
    if(!which){
      showToast(`Couldn't classify ${f.name}. Filename should contain "${LS_CSV_OP_TAG}" (OP) or "${LS_CSV_BB_TAG}" (BB).`);
      continue;
    }
    const rows = await new Promise((resolve,reject)=>{
      Papa.parse(f, {header:true, skipEmptyLines:true, complete:r=>resolve(r.data||[]), error:reject});
    });
    const processed = lsProcessCsvRows(rows);
    if(which==='op') lsState.csvOp = {file:f, rows:processed};
    else lsState.csvBb = {file:f, rows:processed};
  }
  renderCsvFiles();
  refreshPreview();
}

function lsProcessCsvRows(rows){
  // Aggregate 30-min counts into hourly buckets
  const hourData = Object.create(null);
  rows.forEach(row=>{
    const time = row['@timestamp per 30 minutes'];
    const rawCount = row['Count'];
    if(!time) return;
    const cleaned = String(rawCount).replace(/,/g,'').trim();
    const count = parseInt(cleaned,10) || 0;
    const [hh, mm] = String(time).split(':');
    const hour = parseInt(hh,10);
    const minute = parseInt(mm,10);
    const hourKey = `${String(hour).padStart(2,'0')}:00-${String(hour).padStart(2,'0')}:59`;
    const half = minute < 30 ? 'first' : 'second';
    if(!hourData[hourKey]) hourData[hourKey] = {first:0, second:0};
    hourData[hourKey][half] += count;
  });
  return Object.entries(hourData).map(([slot, h])=>[slot, h.first, h.second, h.first+h.second]);
}

function renderCsvFiles(){
  const el = document.getElementById('lsCsvFiles');
  if(!el) return;
  const items = [];
  if(lsState.csvOp) items.push({which:'op', name:lsState.csvOp.file.name});
  if(lsState.csvBb) items.push({which:'bb', name:lsState.csvBb.file.name});
  el.innerHTML = items.map(i=>`<div class="ls-csv-file is-${i.which}">${i.which.toUpperCase()}: ${esc(i.name)}<button onclick="lsRemoveCsv('${i.which}')">×</button></div>`).join('');
}

function lsRemoveCsv(which){
  if(which==='op') lsState.csvOp = null;
  else lsState.csvBb = null;
  renderCsvFiles();
  refreshPreview();
}

// Builds the merged final summary table from the parsed OP and BB
// CSV rows. The output is what gets pasted into the Line Status email
// and is one row per hour the line ran (slots with no data on either
// track are omitted). Running total and projected remaining are
// calculated cumulatively across the rotation-corrected slot order.
// Returns null if the projected total has not been entered or both
// CSVs are missing.
function lsBuildFinalTable(){
  const projected = parseFloat(lsState.projected);
  if(!Number.isFinite(projected)) return null;
  const opData = lsState.csvOp?.rows || [];
  const bbData = lsState.csvBb?.rows || [];
  if(!opData.length && !bbData.length) return null;

  const allSlots = new Set([...opData.map(r=>r[0]), ...bbData.map(r=>r[0])]);
  // Infer shift start hour by finding the start that produces longest consecutive run
  const startHour = lsInferShiftStart(allSlots);
  const sortedSlots = Array.from(allSlots).sort((a,b)=>{
    let ha = parseInt(String(a).split(':')[0],10);
    let hb = parseInt(String(b).split(':')[0],10);
    if(ha >= startHour) ha -= 24;
    if(hb >= startHour) hb -= 24;
    return ha - hb;
  });

  const opMap = new Map(opData.map(r=>[r[0], r]));
  const bbMap = new Map(bbData.map(r=>[r[0], r]));

  const out = [];
  let running = 0;
  sortedSlots.forEach((slot, idx)=>{
    const bb = bbMap.get(slot) || [slot,0,0,0];
    const op = opMap.get(slot) || [slot,0,0,0];
    const hourly = (bb[3]||0) + (op[3]||0);
    running += hourly;
    const remaining = projected - running;
    out.push({
      time: slot,
      bb: bb[3]||0,
      op: op[3]||0,
      hourly,
      running,
      remaining,
      projected: idx===0 ? projected : ''
    });
  });
  return out;
}

// Infers the shift start hour from a set of timestamp slots.
// FlexLab CSVs use 24-hour times in chronological order, but the same
// time format is used for both day shifts (07:00 to 19:00) and night
// shifts that cross midnight (e.g. 19:00 to 04:00 next day). When a
// night shift's data is sorted naively, midnight-crossing causes the
// earliest hours to appear LAST instead of first.
//
// The algorithm rotates each candidate start hour to position 0 (by
// subtracting 24 from any hour at or after the candidate start) and
// scores how many adjacent hours are consecutive after the rotation.
// The highest-scoring rotation is the actual shift start. This
// handles all valid shift configurations without hardcoding times.
function lsInferShiftStart(slots){
  if(!slots.size) return 7;
  let best = 7, bestScore = -1;
  for(let h=0; h<24; h++){
    const sorted = Array.from(slots).sort((a,b)=>{
      let ha = parseInt(String(a).split(':')[0],10);
      let hb = parseInt(String(b).split(':')[0],10);
      if(ha >= h) ha -= 24;
      if(hb >= h) hb -= 24;
      return ha - hb;
    });
    const hours = sorted.map(s=>parseInt(String(s).split(':')[0],10));
    let score = 0;
    for(let i=1; i<hours.length; i++){
      const diff = (hours[i] - hours[i-1] + 24) % 24;
      if(diff===1) score++;
    }
    if(score > bestScore){ bestScore = score; best = h; }
  }
  return best;
}

// Render the full HTML preview with INLINE styles.
// Important context discovered through testing:
// - Inline CSS background on <td>/<th> SURVIVES Outlook web sanitization
// - Inline CSS color via <span style="color:..."> SURVIVES if no parent fights it
// - Margin/padding CSS gets stripped, so we use <br><br> for vertical spacing
// - Width control survives via explicit <colgroup>/<col> declarations
function renderLsHTML(){
  const final = lsBuildFinalTable();
  const fmt = n => typeof n === 'number' ? n.toLocaleString() : (n || '');

  const T_RESET = 'border-collapse:collapse;font-family:Calibri,Arial,sans-serif;';
  const TD_BASE = 'border:1px solid #000;padding:4px 7px;font-size:11px;font-family:Calibri,Arial,sans-serif;text-align:center;vertical-align:middle;';
  const TH_BASE = TD_BASE + 'font-weight:bold;';
  const TH_WHITE = TH_BASE + 'background:#FFFFFF;';
  const BLUE = 'background:#ADD8E6;';
  const YELLOW = 'background:#FFDE2A;';
  const RED = 'background:#FF5B5B;';
  const C_BB = 'color:#D9A300;mso-color-alt:#D9A300;';
  const C_OP = 'color:#C00000;mso-color-alt:#C00000;';
  const C_SEC = 'color:#1F4E79;mso-color-alt:#1F4E79;';

  // Helper: td/th with explicit width attribute AND inline style width so
  // Outlook honours it (colgroup/col is ignored by Outlook on paste).
  const th = (w, style, content, extra) => `<th width="${w}"${extra||''} style="${style}width:${w}px;">${content}</th>`;
  const td = (w, style, content, extra) => `<td width="${w}"${extra||''} style="${style}width:${w}px;">${content}</td>`;

  const SECH = (txt) => `<p style="${C_SEC}font-weight:bold;margin:8px 0 2px 0;font-family:Calibri,Arial,sans-serif;font-size:13px"><b>${txt}</b></p>`;
  const BBH  = (txt) => `<p style="${C_BB}font-weight:bold;margin:4px 0 0 0;font-family:Calibri,Arial,sans-serif;font-size:12px"><b>${txt}</b></p>`;
  const OPH  = (txt) => `<p style="${C_OP}font-weight:bold;margin:4px 0 0 0;font-family:Calibri,Arial,sans-serif;font-size:12px"><b>${txt}</b></p>`;
  const SPACE = '<div style="height:8px;line-height:8px">&nbsp;</div>';

  let html = '';

  // Final table: 7 core columns × 64px = 448px, plus optional ROM column (100px)
  if(final){
    const deleted = new Set(lsState.deletedSlots || []);
    const romNotes = lsState.romNotes || {};
    const visibleRows = final.filter(r => !deleted.has(r.time));
    const hasRom = visibleRows.some(r => romNotes[r.time]);
    const totalW = hasRom ? 548 : 448;
    html += `<table width="${totalW}" cellpadding="0" cellspacing="0" style="${T_RESET}width:${totalW}px;">` +
      `<thead><tr>` +
      th(64, TH_BASE+BLUE,   'Time') +
      th(64, TH_BASE+YELLOW, 'BB Total') +
      th(64, TH_BASE+RED,    'OP Total') +
      th(64, TH_BASE+BLUE,   'Hourly Total') +
      th(64, TH_BASE+BLUE,   'Running Total') +
      th(64, TH_BASE+BLUE,   'Projected Remaining') +
      th(64, TH_BASE+BLUE,   'Projected') +
      (hasRom ? th(100, TH_BASE+BLUE, 'ROM Samples') : '') +
      `</tr></thead><tbody>`;
    visibleRows.forEach(r=>{
      const rom = romNotes[r.time] || '';
      html += `<tr>` +
        td(64, TD_BASE+BLUE+'font-weight:bold;', `<b>${esc(r.time)}</b>`) +
        td(64, TD_BASE, fmt(r.bb)) +
        td(64, TD_BASE, fmt(r.op)) +
        td(64, TD_BASE, fmt(r.hourly)) +
        td(64, TD_BASE, fmt(r.running)) +
        td(64, TD_BASE, fmt(r.remaining)) +
        td(64, TD_BASE, fmt(r.projected)) +
        (hasRom ? td(100, TD_BASE+'text-align:left;', esc(rom)) : '') +
      `</tr>`;
    });
    html += `</tbody></table>`;
    html += SPACE;
  } else {
    html += `<div style="font-style:italic;color:#777;font-size:11px;margin:10px 0;font-family:Calibri,Arial,sans-serif">Upload CSV files and enter projected to generate the table.</div>`;
  }

  // Unpacking + Shipments: 5 columns (100+50+50+50+50 = 300px)
  const unp = lsState.unpacking;
  const anyUnp = unp.ongoing || unp.completed || unp.lh_flx || unp.lh_fedex || unp.lh_ups || unp.lh_wc;
  if(anyUnp){
    html += SECH("UNPACKING/SHIPMENTS:");
    html += `<table width="300" cellpadding="0" cellspacing="0" style="${T_RESET}width:300px;">` +
      `<tr>` +
        `<td width="100" rowspan="2" style="${TD_BASE}font-weight:bold;text-align:left;width:100px;"><b>Unpacking:</b></td>` +
        `<th width="100" colspan="2" style="${TH_WHITE}width:100px;">Ongoing</th>` +
        `<th width="100" colspan="2" style="${TH_WHITE}width:100px;">Completed</th>` +
      `</tr><tr>` +
        `<td width="100" colspan="2" style="${TD_BASE}width:100px;">${unp.ongoing?'X':''}</td>` +
        `<td width="100" colspan="2" style="${TD_BASE}width:100px;">${unp.completed?'X':''}</td>` +
      `</tr><tr>` +
        td(100, TD_BASE+'font-weight:bold;text-align:left;', '<b>Line Haul:</b>') +
        th(50,  TH_WHITE, 'FLX') +
        th(50,  TH_WHITE, 'FedEx') +
        th(50,  TH_WHITE, 'UPS') +
        th(50,  TH_WHITE, 'WC') +
      `</tr><tr>` +
        td(100, TD_BASE, '') +
        td(50,  TD_BASE, unp.lh_flx?'X':'') +
        td(50,  TD_BASE, unp.lh_fedex?'X':'') +
        td(50,  TD_BASE, unp.lh_ups?'X':'') +
        td(50,  TD_BASE, unp.lh_wc?'X':'') +
      `</tr>` +
    `</table>`;
    html += SPACE;
  }

  // BB / OP notes
  if(lsState.bbNotes.trim()){
    html += BBH('BB:') + `<ul style="margin:4px 0 8px 22px;padding:0;font-family:Calibri,Arial,sans-serif">${noteLines(lsState.bbNotes)}</ul>`;
  }
  if(lsState.opNotes.trim()){
    html += OPH('OP:') + `<ul style="margin:4px 0 8px 22px;padding:0;font-family:Calibri,Arial,sans-serif">${noteLines(lsState.opNotes)}</ul>`;
  }
  if(lsState.bbNotes.trim() || lsState.opNotes.trim()) html += SPACE;

  // Startup Times: 5 columns, 375px total
  const anyStartup = lsState.startup.some(r=>r.bb||r.op||r.full||r.partial);
  if(anyStartup){
    html += SECH("Startup Time(s):");
    html += `<table width="375" cellpadding="0" cellspacing="0" style="${T_RESET}width:375px;">` +
      `<thead><tr>` +
      th(160, TH_WHITE+'text-align:left;', 'Departments/Module') +
      th(55,  TH_BASE+YELLOW+'color:#000;', 'BB') +
      th(55,  TH_BASE+RED+'color:#000;', 'OP') +
      th(50,  TH_WHITE, 'Full') +
      th(55,  TH_WHITE, 'Partial') +
      `</tr></thead><tbody>`;
    lsState.startup.forEach(r=>{
      html += `<tr>` +
        td(160, TD_BASE+'text-align:left;font-weight:bold;', `<b>${esc(r.dept)}:</b>`) +
        td(55,  TD_BASE, esc(r.bb)) +
        td(55,  TD_BASE, esc(r.op)) +
        td(50,  TD_BASE, r.full?'X':'') +
        td(55,  TD_BASE, r.partial?'X':'') +
      `</tr>`;
    });
    html += `</tbody></table>`;
    html += SPACE;
  }

  // Buckets to Load
  if(lsState.bucketCount!=='' || lsState.bucketTime){
    html += SECH("Buckets to Load:");
    html += `<table cellpadding="0" cellspacing="0" style="${T_RESET}">` +
      `<tbody><tr>` +
      td('auto', TD_BASE+'font-weight:bold;padding:5px 12px;', `<b>${esc(lsState.bucketCount)} @ ${esc(lsState.bucketTime)}</b>`) +
      `</tr></tbody></table>`;
    if(lsState.bucketNotes.trim()){
      html += `<div style="font-size:12px;margin-top:4px;font-family:Calibri,Arial,sans-serif">${esc(lsState.bucketNotes).replace(/\n/g,'<br>')}</div>`;
    }
    html += SPACE;
  }

  // Pending Buckets to Relabel: 2 columns × 60px = 120px
  if(lsState.relabelBb!=='' || lsState.relabelOp!==''){
    html += SECH("Pending Buckets to Relabel:");
    html += `<table width="120" cellpadding="0" cellspacing="0" style="${T_RESET}width:120px;">` +
      `<thead><tr>` +
      th(60, TH_BASE+YELLOW+'color:#000;', 'BB') +
      th(60, TH_BASE+RED+'color:#000;', 'OP') +
      `</tr></thead><tbody><tr>` +
      td(60, TD_BASE, esc(lsState.relabelBb)) +
      td(60, TD_BASE, esc(lsState.relabelOp)) +
      `</tr></tbody></table>`;
    html += SPACE;
  }

  // OOS Analyzers: 4 columns, 440px total
  const hasOos = Object.values(lsState.oos).some(arr=>arr.length);
  if(hasOos){
    html += SECH("OOS Analyzers:");
    html += `<table width="440" cellpadding="0" cellspacing="0" style="${T_RESET}width:440px;">` +
      `<thead><tr>` +
      th(65,  TH_BASE+YELLOW+'color:#000;text-align:left;', 'BB') +
      th(155, TH_BASE+YELLOW+'color:#000;text-align:left;', '') +
      th(65,  TH_BASE+RED+'color:#000;text-align:left;', 'OP') +
      th(155, TH_BASE+RED+'color:#000;text-align:left;', '') +
      `</tr></thead><tbody>`;
    ['hemo','special','auto'].forEach(d=>{
      const lbl = d==='hemo'?'HEMO':d==='special'?'SPECIAL':'AUTO';
      html += `<tr>` +
        td(65,  TD_BASE+'text-align:left;font-weight:bold;', `<b>${lbl}:</b>`) +
        td(155, TD_BASE+'text-align:left;', lsState.oos['bb_'+d].map(esc).join(', ')) +
        td(65,  TD_BASE+'text-align:left;font-weight:bold;', `<b>${lbl}:</b>`) +
        td(155, TD_BASE+'text-align:left;', lsState.oos['op_'+d].map(esc).join(', ')) +
      `</tr>`;
    });
    html += `</tbody></table>`;
    html += SPACE;
  }

  // Overloads / Buffer Status: 4 columns, 330px total
  const hasOver = Object.values(lsState.overloads).some(v=>v) || lsState.overloadNotes.trim();
  if(hasOver){
    html += SECH("Overloads/Buffer Status:");
    html += `<table width="330" cellpadding="0" cellspacing="0" style="${T_RESET}width:330px;">` +
      `<thead><tr>` +
      th(65,  TH_BASE+YELLOW+'color:#000;text-align:left;', 'BB') +
      th(100, TH_WHITE, '') +
      th(65,  TH_BASE+RED+'color:#000;text-align:left;', 'OP') +
      th(100, TH_WHITE, '') +
      `</tr></thead><tbody>`;
    ['hemo','special','auto'].forEach(d=>{
      const lbl = d==='hemo'?'HEMO':d==='special'?'SPECIAL':'AUTO';
      html += `<tr>` +
        td(65,  TD_BASE+'text-align:left;font-weight:bold;', `<b>${lbl}:</b>`) +
        td(100, TD_BASE+'text-align:left;', esc(lsState.overloads['bb_'+d])) +
        td(65,  TD_BASE+'text-align:left;font-weight:bold;', `<b>${lbl}:</b>`) +
        td(100, TD_BASE+'text-align:left;', esc(lsState.overloads['op_'+d])) +
      `</tr>`;
    });
    html += `</tbody></table>`;
    if(lsState.overloadNotes.trim()){
      html += `<div style="font-size:12px;margin-top:4px;background:#fde2e2;padding:3px 6px;font-family:Calibri,Arial,sans-serif">${esc(lsState.overloadNotes).replace(/\n/g,'<br>')}</div>`;
    }
    html += SPACE;
  }

  // BIM Read Rates: 4 columns side by side (70+90+70+90 = 320px)
  // Label columns are 70px so "IOM 1" / "IOM 2" never wrap.
  // BB and OP each span their two columns as a unified colored header.
  const hasBim = lsState.bim.bb.some(v=>v) || lsState.bim.op.some(v=>v);
  if(hasBim){
    html += SECH("BIM Read Rates:");
    const labels = ['1','2','3','4','5','6','7','8','IOM 1','IOM 2'];
    html += `<table width="320" cellpadding="0" cellspacing="0" style="${T_RESET}width:320px;">` +
      `<thead>` +
      `<tr>` +
      `<th width="160" colspan="2" style="${TH_BASE}${YELLOW}color:#000;width:160px;">BB</th>` +
      `<th width="160" colspan="2" style="${TH_BASE}${RED}color:#000;width:160px;">OP</th>` +
      `</tr><tr>` +
      th(70,  TH_WHITE+'white-space:nowrap;', '#') +
      th(90,  TH_WHITE, '% Success') +
      th(70,  TH_WHITE+'white-space:nowrap;', '#') +
      th(90,  TH_WHITE, '% Success') +
      `</tr>` +
      `</thead><tbody>`;
    labels.forEach((lbl,i)=>{
      const bbVal = lsState.bim.bb[i] || '-';
      const opVal = lsState.bim.op[i] || '-';
      html += `<tr>` +
        td(70,  TD_BASE+'font-weight:bold;white-space:nowrap;', `<b>${lbl}</b>`) +
        td(90,  TD_BASE, esc(bbVal)) +
        td(70,  TD_BASE+'font-weight:bold;white-space:nowrap;', `<b>${lbl}</b>`) +
        td(90,  TD_BASE, esc(opVal)) +
      `</tr>`;
    });
    html += `</tbody></table>`;
  }

  return html;
}

function noteLines(text){
  return text.split('\n').filter(l=>l.trim()).map(l=>`<li>${esc(l.trim())}</li>`).join('');
}

// Copy preview HTML to clipboard as rich content (so it pastes into email clients formatted)
async function lsCopy(){
  try {
    // Use renderLsHTML() directly so the clean copy-ready output is used
    // rather than the preview innerHTML which contains interactive controls
    // (delete buttons, ROM inputs) that should not appear in the email.
    const bodyHtml = renderLsHTML();
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="Microsoft Word 15">
<meta name="Originator" content="Microsoft Word 15">
</head>
<body>${bodyHtml}</body></html>`;
    const text = bodyHtml.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    if(navigator.clipboard?.write){
      const blob = new Blob([html], {type:'text/html'});
      const textBlob = new Blob([text], {type:'text/plain'});
      await navigator.clipboard.write([new ClipboardItem({'text/html':blob, 'text/plain':textBlob})]);
    } else {
      // Fallback: select + execCommand
      const range = document.createRange();
      range.selectNode(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('copy');
      window.getSelection().removeAllRanges();
    }
    showToast('Copied to clipboard. Paste into your email.');
  } catch(e){
    console.warn('Copy failed:',e);
    showToast('Copy failed. Try again.');
  }
}

// Save snapshot to Firestore (excludes the CSV-derived final table by design)
async function lsSaveSnapshot(){
  const snapshot = {...lsState};
  // Don't store the actual CSV file objects, just remove them
  delete snapshot.csvOp;
  delete snapshot.csvBb;
  await db.collection('lsSnapshots').add({
    data: JSON.stringify(snapshot),
    submittedBy: user.name,
    role: user.role,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  showToast('Snapshot saved.');
}

// ── SNAPSHOTS TAB ──────────────────────────────────────────────
// Saved-snapshot browser. Each saved snapshot is a serialized
// snapshot of the form state at the time of save (CSV-derived data
// excluded). Snapshots from both Line Status and EOD share a single
// Firestore collection (lsSnapshots) differentiated by a 'type'
// field. Auto-purges daily at 6am EST.
async function renderSnapshots(){
  const body = document.getElementById('reportsBody');
  body.innerHTML = `<div style="font-size:13px;color:var(--muted);margin-bottom:6px">Snapshots auto-purge daily at 6:00 AM EST. CSV-derived tables are not saved.</div><div class="snap-list" id="snapList">Loading...</div>`;
  const snap = await db.collection('lsSnapshots').orderBy('createdAt','desc').get();
  const items = snap.docs.map(d=>({id:d.id, ...d.data()}));
  const list = document.getElementById('snapList');
  if(!items.length){
    list.innerHTML = '<div style="color:var(--muted);font-style:italic;padding:20px;text-align:center">No snapshots yet.</div>';
    return;
  }
  list.innerHTML = items.map(s=>{
    const type = s.type === 'eod' ? 'EOD' : 'Line Status';
    const typeColor = s.type === 'eod' ? '#10b981' : '#3b82f6';
    return `<div class="snap-item">
      <div class="snap-info">
        <div style="font-weight:600">
          <span style="background:${typeColor};color:#fff;font-size:10px;padding:1px 7px;border-radius:10px;font-weight:700;margin-right:6px;text-transform:uppercase">${type}</span>
          ${esc(s.submittedBy||'?')}
        </div>
        <div class="snap-time">${fmtTime(s.createdAt)}</div>
      </div>
      <div class="snap-actions">
        <button onclick="lsLoadSnapshot('${s.id}')">Load</button>
        <button class="del" onclick="lsDeleteSnapshot('${s.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function lsLoadSnapshot(id){
  const doc = await db.collection('lsSnapshots').doc(id).get();
  if(!doc.exists) return;
  const docData = doc.data();
  const data = JSON.parse(docData.data);
  if(docData.type === 'eod'){
    // Load into eodState and switch to EOD tab
    Object.assign(eodState, data);
    switchReportTab('eod');
    showToast('EOD snapshot loaded into form.');
  } else {
    // Default: line status. CSV-derived state is not stored.
    Object.assign(lsState, data);
    lsState.csvOp = null;
    lsState.csvBb = null;
    switchReportTab('ls');
    showToast('Line Status snapshot loaded into form.');
  }
}

async function lsDeleteSnapshot(id){
  if(!confirm('Delete this snapshot?')) return;
  await db.collection('lsSnapshots').doc(id).delete();
  renderSnapshots();
  showToast('Snapshot deleted.');
}

// Purges old Line Status and EOD snapshots once per day at 6am EST.
// Implementation runs opportunistically at app load: each client checks
// the last-purge timestamp stored in /meta/snapshots and runs the
// cleanup only if the most recent 6am cutoff has not yet been processed.
// This avoids needing a server-side cron and tolerates clients in any
// timezone (the EST offset is hardcoded; daylight saving time is not
// adjusted because the team is in Eastern Time year-round).
async function purgeSnapshotsDaily(){
  try {
    const now = new Date();
    const utc = now.getTime();
    const est = new Date(utc - 5*60*60*1000);
    const dow = est.getUTCDay();
    const cutoff = new Date(est);
    cutoff.setUTCHours(6,0,0,0);
    if(est.getUTCHours() < 6){
      cutoff.setUTCDate(cutoff.getUTCDate() - 1);
    }
    const cutoffMs = cutoff.getTime() + 5*60*60*1000;

    const metaRef = db.collection('meta').doc('snapshots');
    const metaSnap = await metaRef.get();
    const lastRun = metaSnap.exists ? (metaSnap.data().lastPurge?.toMillis?.() || 0) : 0;
    if(lastRun >= cutoffMs) return;

    const old = await db.collection('lsSnapshots').where('createdAt','<', new Date(cutoffMs)).get();
    let deleted = 0;
    for(const d of old.docs){ await d.ref.delete(); deleted++; }
    await metaRef.set({lastPurge: firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
    if(deleted) console.log(`Purged ${deleted} old snapshot(s).`);
  } catch(e){ console.warn('Snapshot purge failed:',e); }
}

// ── EOD TAB ────────────────────────────────────────────────────
// End-of-Day report builder. Mirrors the official Automated Line EOD
// Report Word template structure: staffing, remaining samples (in
// freezer and on line), BB/OP issues split by category (BIM, general,
// HVS), maintenance task completion, instrument issues, and bulleted
// notes. Issues can be auto-pulled from any board's active cards via
// the board picker. Output uses the same email-friendly inline-style
// approach as Line Status for clean copy-paste.
// EOD report state. Form data plus auto-pulled BB/OP issues from the board.
let eodState = {
  date: '',
  reportOn: 'Automated Line',
  staffingPct: '100%',
  callOutChecked: false,
  callOutCount: '',
  scheduledPtoChecked: false,
  scheduledPtoCount: '',
  remainingFreezerYes: false,
  remainingFreezerNo: false,
  freezerSamplesNum: 'N/A',
  freezerSamplesType: 'N/A',
  freezerReasonTrack: false,
  freezerReasonStaffing: false,
  freezerReasonHighVol: false,
  freezerReasonOther: false,
  freezerReasonOtherText: '',
  // Remaining samples on line: dropdowns for OP and BB (complete and incomplete)
  lineSamplesBbComplete: 'N/A',
  lineSamplesBbIncomplete: 'N/A',
  lineSamplesOpComplete: 'N/A',
  lineSamplesOpIncomplete: 'N/A',
  lineSamplesDept: 'N/A',
  lineSamplesReasonTrack: false,
  lineSamplesReasonStaffing: false,
  lineSamplesReasonHighVol: false,
  bbBimIssues: 'N/A',
  opBimIssues: 'N/A',
  bbIssues: 'N/A',
  opIssues: 'N/A',
  bbHvsIssues: 'N/A',
  opHvsIssues: 'N/A',
  maintOpYes: false,
  maintOpNo: false,
  maintBbYes: false,
  maintBbNo: false,
  maintRemaining: 'N/A',
  instrumentIssues: 'N/A',
  eodNotes: ''
};

// Source board selectors for auto-pull (separate from the active board the user is viewing)
let lsSourceBoard = null; // null = use currently active board
let eodSourceBoard = null;

const EOD_SAMPLE_COUNTS = ['N/A', ...range(0,1000)];
// Sample types and departments share the same options
const EOD_DEPT_OPTIONS = ['N/A','All','Hemo','Special','Auto'];

function renderEOD(){
  if(!eodState.date) eodState.date = formatTodayLong();
  const body = document.getElementById('reportsBody');
  body.innerHTML = `
    <div class="reports-split">
      <div class="ls-form">
        <div class="ls-section">
          <div class="ls-sec-title">Header</div>
          <div class="ls-row">
            <span class="ls-lbl">Date:</span>
            <input class="ls-mini" style="flex:1" value="${esc(eodState.date)}" oninput="eodUpdate('date',this.value)" />
          </div>
          <div class="ls-row">
            <span class="ls-lbl">Report on:</span>
            <input class="ls-mini" style="flex:1" value="${esc(eodState.reportOn)}" oninput="eodUpdate('reportOn',this.value)" />
          </div>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Staffing</div>
          <div class="ls-row">
            <span class="ls-lbl">Staffing %:</span>
            <input class="ls-mini w90" value="${esc(eodState.staffingPct)}" oninput="eodUpdate('staffingPct',this.value)" />
          </div>
          <div class="ls-row" style="margin-top:8px">
            <div class="ls-x-cell ${eodState.callOutChecked?'checked':''}" onclick="eodToggle('callOutChecked')">${eodState.callOutChecked?'X':''}</div>
            <span style="font-weight:600;font-size:12px">Call out / sick call:</span>
            <input class="ls-mini w70" value="${esc(eodState.callOutCount)}" placeholder="# TMs" oninput="eodUpdate('callOutCount',this.value)" />
          </div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.scheduledPtoChecked?'checked':''}" onclick="eodToggle('scheduledPtoChecked')">${eodState.scheduledPtoChecked?'X':''}</div>
            <span style="font-weight:600;font-size:12px">Scheduled PTO:</span>
            <input class="ls-mini w70" value="${esc(eodState.scheduledPtoCount)}" placeholder="# TMs" oninput="eodUpdate('scheduledPtoCount',this.value)" />
          </div>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Remaining Samples (in freezer)</div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.remainingFreezerYes?'checked':''}" onclick="eodToggle('remainingFreezerYes')">${eodState.remainingFreezerYes?'X':''}</div>
            <span style="font-weight:600;font-size:12px">YES</span>
            <span style="margin-left:14px"></span>
            <div class="ls-x-cell ${eodState.remainingFreezerNo?'checked':''}" onclick="eodToggle('remainingFreezerNo')">${eodState.remainingFreezerNo?'X':''}</div>
            <span style="font-weight:600;font-size:12px">NO</span>
          </div>
          <div class="ls-row" style="margin-top:8px">
            <span class="ls-lbl">No. of Samples:</span>
            <input class="ls-mini w90" value="${esc(eodState.freezerSamplesNum)}" oninput="eodUpdate('freezerSamplesNum',this.value)" />
          </div>
          <div class="ls-row">
            <span class="ls-lbl">Sample Type(s):</span>
            ${comboInput('dl_eodFreezerType', EOD_DEPT_OPTIONS, eodState.freezerSamplesType, "eodUpdate('freezerSamplesType',this.value)", '')}
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--muted);margin-top:8px;margin-bottom:4px">Reason:</div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.freezerReasonTrack?'checked':''}" onclick="eodToggle('freezerReasonTrack')">${eodState.freezerReasonTrack?'X':''}</div>
            <span style="font-size:12px">Track/Automation</span>
          </div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.freezerReasonStaffing?'checked':''}" onclick="eodToggle('freezerReasonStaffing')">${eodState.freezerReasonStaffing?'X':''}</div>
            <span style="font-size:12px">Staffing</span>
          </div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.freezerReasonHighVol?'checked':''}" onclick="eodToggle('freezerReasonHighVol')">${eodState.freezerReasonHighVol?'X':''}</div>
            <span style="font-size:12px">High Volume</span>
          </div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.freezerReasonOther?'checked':''}" onclick="eodToggle('freezerReasonOther')">${eodState.freezerReasonOther?'X':''}</div>
            <span style="font-size:12px">Other (Explain):</span>
            <input class="ls-mini" style="flex:1" value="${esc(eodState.freezerReasonOtherText)}" oninput="eodUpdate('freezerReasonOtherText',this.value)" />
          </div>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Remaining Samples on Line</div>
          <div class="ls-grid ls-grid-2">
            <div class="ls-cell">
              <div class="ls-cell-hdr bb">BB Complete</div>
              <input class="ls-mini" type="text" inputmode="numeric" value="${esc(eodState.lineSamplesBbComplete)}" placeholder="N/A" oninput="eodUpdate('lineSamplesBbComplete',this.value)" />
            </div>
            <div class="ls-cell">
              <div class="ls-cell-hdr bb">BB Incomplete</div>
              <input class="ls-mini" type="text" inputmode="numeric" value="${esc(eodState.lineSamplesBbIncomplete)}" placeholder="N/A" oninput="eodUpdate('lineSamplesBbIncomplete',this.value)" />
            </div>
            <div class="ls-cell">
              <div class="ls-cell-hdr op">OP Complete</div>
              <input class="ls-mini" type="text" inputmode="numeric" value="${esc(eodState.lineSamplesOpComplete)}" placeholder="N/A" oninput="eodUpdate('lineSamplesOpComplete',this.value)" />
            </div>
            <div class="ls-cell">
              <div class="ls-cell-hdr op">OP Incomplete</div>
              <input class="ls-mini" type="text" inputmode="numeric" value="${esc(eodState.lineSamplesOpIncomplete)}" placeholder="N/A" oninput="eodUpdate('lineSamplesOpIncomplete',this.value)" />
            </div>
          </div>
          <div class="ls-row" style="margin-top:8px">
            <span class="ls-lbl">Departments on Line:</span>
            ${comboInput('dl_eodLineDept', EOD_DEPT_OPTIONS, eodState.lineSamplesDept, "eodUpdate('lineSamplesDept',this.value)", '')}
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--muted);margin-top:8px;margin-bottom:4px">Reason:</div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.lineSamplesReasonTrack?'checked':''}" onclick="eodToggle('lineSamplesReasonTrack')">${eodState.lineSamplesReasonTrack?'X':''}</div>
            <span style="font-size:12px">Track/Automation</span>
          </div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.lineSamplesReasonStaffing?'checked':''}" onclick="eodToggle('lineSamplesReasonStaffing')">${eodState.lineSamplesReasonStaffing?'X':''}</div>
            <span style="font-size:12px">Staffing</span>
          </div>
          <div class="ls-row">
            <div class="ls-x-cell ${eodState.lineSamplesReasonHighVol?'checked':''}" onclick="eodToggle('lineSamplesReasonHighVol')">${eodState.lineSamplesReasonHighVol?'X':''}</div>
            <span style="font-size:12px">High Volume</span>
          </div>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
            BB / OP Issues
            <div style="margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <select class="ls-mini" style="font-size:11px" onchange="eodSourceBoard=this.value||null">
                <option value="">Current board</option>
                ${boards.map(b=>`<option value="${b.id}" ${eodSourceBoard===b.id?'selected':''}>${esc(b.title)}</option>`).join('')}
              </select>
              <button class="ls-add-btn" style="font-size:11px;padding:3px 9px" onclick="eodRefreshIssues()">Refresh from Board</button>
              ${tt('Pulls open issues from the selected board and fills in the BB and OP issue sections, sorted by instrument type (BIM, HVS, or general). Pick a board from the dropdown first if needed. You can edit the result after it populates.')}
            </div>
          </div>
          <div class="ls-cell-hdr bb" style="margin-top:6px">BB - BIM Issues</div>
          <textarea class="ls-textarea" oninput="eodUpdate('bbBimIssues',this.value)">${esc(eodState.bbBimIssues)}</textarea>
          <div class="ls-cell-hdr op" style="margin-top:8px">OP - BIM Issues</div>
          <textarea class="ls-textarea" oninput="eodUpdate('opBimIssues',this.value)">${esc(eodState.opBimIssues)}</textarea>
          <div class="ls-cell-hdr bb" style="margin-top:8px">BB - Issues</div>
          <textarea class="ls-textarea" oninput="eodUpdate('bbIssues',this.value)">${esc(eodState.bbIssues)}</textarea>
          <div class="ls-cell-hdr op" style="margin-top:8px">OP - Issues</div>
          <textarea class="ls-textarea" oninput="eodUpdate('opIssues',this.value)">${esc(eodState.opIssues)}</textarea>
          <div class="ls-cell-hdr bb" style="margin-top:8px">BB - HVS Issues</div>
          <textarea class="ls-textarea" oninput="eodUpdate('bbHvsIssues',this.value)">${esc(eodState.bbHvsIssues)}</textarea>
          <div class="ls-cell-hdr op" style="margin-top:8px">OP - HVS Issues</div>
          <textarea class="ls-textarea" oninput="eodUpdate('opHvsIssues',this.value)">${esc(eodState.opHvsIssues)}</textarea>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Maintenance Tasks Completed</div>
          <div class="ls-row">
            <span class="ls-lbl" style="color:var(--op);font-weight:700">Optimus Prime:</span>
            <div class="ls-x-cell ${eodState.maintOpYes?'checked':''}" onclick="eodToggle('maintOpYes')">${eodState.maintOpYes?'X':''}</div>
            <span style="font-size:12px">YES</span>
            <span style="margin-left:10px"></span>
            <div class="ls-x-cell ${eodState.maintOpNo?'checked':''}" onclick="eodToggle('maintOpNo')">${eodState.maintOpNo?'X':''}</div>
            <span style="font-size:12px">NO</span>
          </div>
          <div class="ls-row" style="margin-top:6px">
            <span class="ls-lbl" style="color:var(--bb);font-weight:700">Bumblebee:</span>
            <div class="ls-x-cell ${eodState.maintBbYes?'checked':''}" onclick="eodToggle('maintBbYes')">${eodState.maintBbYes?'X':''}</div>
            <span style="font-size:12px">YES</span>
            <span style="margin-left:10px"></span>
            <div class="ls-x-cell ${eodState.maintBbNo?'checked':''}" onclick="eodToggle('maintBbNo')">${eodState.maintBbNo?'X':''}</div>
            <span style="font-size:12px">NO</span>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:8px;font-weight:600">If no, what tasks are remaining?</div>
          <textarea class="ls-textarea" oninput="eodUpdate('maintRemaining',this.value)">${esc(eodState.maintRemaining)}</textarea>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Instrument / Module Issues</div>
          <textarea class="ls-textarea" oninput="eodUpdate('instrumentIssues',this.value)">${esc(eodState.instrumentIssues)}</textarea>
        </div>

        <div class="ls-section">
          <div class="ls-sec-title">Notes</div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px">One note per line. Renders as a bulleted list.</div>
          <textarea class="ls-textarea" style="min-height:90px" placeholder="Any additional notes for the EOD report..." oninput="eodUpdate('eodNotes',this.value)">${esc(eodState.eodNotes)}</textarea>
        </div>

        <div class="ls-actions">
          <button class="btn-clear" onclick="eodClear()">Clear All</button>
          <span class="tt-wrap tt-flip">
            <button class="btn-snap" onclick="eodSaveSnapshot()">Save Snapshot</button>
            <button class="tt-btn" type="button" onclick="ttToggle(event)" aria-label="More information">?</button>
            <span class="tt-box">Saves a draft of this form so you can reload it later from the Saved Snapshots tab.</span>
          </span>
          <span class="tt-wrap tt-flip">
            <button class="btn-copy" onclick="eodCopy()">Copy to Clipboard</button>
            <button class="tt-btn" type="button" onclick="ttToggle(event)" aria-label="More information">?</button>
            <span class="tt-box">Copies the formatted report so you can paste it directly into an Outlook email. Tables and layout are preserved on paste.</span>
          </span>
          <span class="tt-wrap tt-flip">
            <button class="btn-publish" onclick="eodPublish()" title="Publish this EOD so the team can view it under the Today tab">Publish</button>
            <button class="tt-btn" type="button" onclick="ttToggle(event)" aria-label="More information">?</button>
            <span class="tt-box">Posts the current EOD to the Today tab where the whole team can see it in real time. Anyone can edit and republish to correct information without sending a follow-up email.</span>
          </span>
        </div>
      </div>

      <div class="ls-preview">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Live Preview</div>
        <div class="ls-render" id="eodRender">${renderEodHTML()}</div>
      </div>
    </div>
  `;
}

function eodUpdate(field, value){
  eodState[field] = value;
  refreshEodPreview();
}

function eodToggle(field){
  eodState[field] = !eodState[field];
  renderEOD();
}

function refreshEodPreview(){
  const el = document.getElementById('eodRender');
  if(el) el.innerHTML = renderEodHTML();
}

// Auto-pull BB/OP issues from active LabTrack cards. We split BIM-related, HVS-related,
// and general issues into the right sections based on the instrument tag on each card.
// Pulls active (non-resolved) issues from the selected source board
// and routes each into the correct EOD section based on its instrument
// type: cards tagged with BIM go to the BIM Issues row, HVS-tagged
// cards go to the HVS row, and the remainder go to the general Issues
// row. Tracks (BB vs OP) determine which side of the report each
// issue lands on. Empty sections fall back to 'N/A' rather than
// blanking out, matching how the team manually fills the form today.
function eodRefreshIssues(){
  const sourceBid = eodSourceBoard || boardId;
  const activeIssues = issues.filter(i=>i.boardId===sourceBid && i.status!=='resolved');
  const groupActive = (track) => activeIssues.filter(i=>i.track===track);
  const formatLine = (i) => {
    const inst = [i.instrumentType, i.unitNumber].filter(Boolean).join(' ');
    return inst ? `${inst}: ${i.title}` : i.title;
  };
  const isBim = i => /BIM/i.test(i.instrumentType||'');
  const isHvs = i => /HVS/i.test(i.instrumentType||'');

  const bb = groupActive('bb');
  const op = groupActive('op');

  eodState.bbBimIssues = bb.filter(isBim).map(formatLine).join('\n') || 'N/A';
  eodState.opBimIssues = op.filter(isBim).map(formatLine).join('\n') || 'N/A';
  eodState.bbHvsIssues = bb.filter(isHvs).map(formatLine).join('\n') || 'N/A';
  eodState.opHvsIssues = op.filter(isHvs).map(formatLine).join('\n') || 'N/A';
  eodState.bbIssues = bb.filter(i=>!isBim(i)&&!isHvs(i)).map(formatLine).join('\n') || 'N/A';
  eodState.opIssues = op.filter(i=>!isBim(i)&&!isHvs(i)).map(formatLine).join('\n') || 'N/A';
  renderEOD();
  const boardName = boards.find(b=>b.id===sourceBid)?.title || 'current board';
  showToast(`Issues refreshed from "${boardName}".`);
}

function eodClear(){
  if(!confirm('Clear all EOD fields?')) return;
  const keepDate = formatTodayLong();
  eodState = {
    date: keepDate, reportOn: 'Automated Line', staffingPct: '100%',
    callOutChecked:false, callOutCount:'', scheduledPtoChecked:false, scheduledPtoCount:'',
    remainingFreezerYes:false, remainingFreezerNo:false,
    freezerSamplesNum:'N/A', freezerSamplesType:'N/A',
    freezerReasonTrack:false, freezerReasonStaffing:false, freezerReasonHighVol:false,
    freezerReasonOther:false, freezerReasonOtherText:'',
    lineSamplesBbComplete:'N/A', lineSamplesBbIncomplete:'N/A',
    lineSamplesOpComplete:'N/A', lineSamplesOpIncomplete:'N/A',
    lineSamplesDept:'N/A',
    lineSamplesReasonTrack:false, lineSamplesReasonStaffing:false, lineSamplesReasonHighVol:false,
    bbBimIssues:'N/A', opBimIssues:'N/A', bbIssues:'N/A', opIssues:'N/A',
    bbHvsIssues:'N/A', opHvsIssues:'N/A',
    maintOpYes:false, maintOpNo:false, maintBbYes:false, maintBbNo:false,
    maintRemaining:'N/A', instrumentIssues:'N/A', eodNotes:''
  };
  renderEOD();
  showToast('EOD cleared.');
}

// Build the EOD report HTML in the same email-friendly format as Line Status.
function renderEodHTML(){
  const T  = 'border-collapse:collapse;font-family:Calibri,Arial,sans-serif;width:100%;';
  const TD = 'border:1px solid #000;padding:5px 8px;font-size:12px;font-family:Calibri,Arial,sans-serif;vertical-align:top;';
  const TH_TOP  = TD + 'font-weight:bold;background:#FCE4D6;';
  // White background on all non-header left cells
  const TH_L = TD + 'font-weight:bold;';
  const x = b => b ? '&#9746;' : '&#9744;';

  let html = '<h1 style="font-family:Calibri,Arial,sans-serif;font-size:18px;font-weight:bold;text-align:center;margin:0 0 12px 0">Automated Line EOD Report</h1>';

  // Single outer table, 4 columns: [label | col2 | col3 | col4]
  // colgroup pins widths so nothing bleeds out
  html += '<table cellpadding="0" cellspacing="0" style="' + T + '">' +
    '<colgroup><col width="28%"><col width="24%"><col width="24%"><col width="24%"></colgroup>' +
    '<tbody>';

  // Row 1: orange header
  html += '<tr>' +
    '<td style="' + TH_TOP + '"><b>DATE: ' + esc(eodState.date) + '</b></td>' +
    '<td style="' + TH_TOP + '" colspan="3"><b>Report on: ' + esc(eodState.reportOn) + '</b></td>' +
  '</tr>';

  // Row 2: Staffing
  html += '<tr>' +
    '<td style="' + TH_L + '"><b>STAFFING:</b><br>' + esc(eodState.staffingPct) + '</td>' +
    '<td style="' + TD + '" colspan="3">' +
      '<b>Please indicate number of TMs if checked</b><br>' +
      x(eodState.callOutChecked) + ' Call out/sick call: ' + esc(eodState.callOutCount) + '<br>' +
      x(eodState.scheduledPtoChecked) + ' Scheduled PTO: ' + esc(eodState.scheduledPtoCount) +
    '</td>' +
  '</tr>';

  // Row 3: Remaining in freezer YES/NO
  html += '<tr>' +
    '<td style="' + TH_L + '"><b>Remaining samples (in freezer)</b></td>' +
    '<td style="' + TD + '" colspan="2">' + x(eodState.remainingFreezerYes) + ' <b>YES</b></td>' +
    '<td style="' + TD + '">' + x(eodState.remainingFreezerNo) + ' <b>NO</b></td>' +
  '</tr>';

  // Row 4: If yes... left label + 3 sub-columns
  const fReason =
    x(eodState.freezerReasonTrack) + ' Track/Automation<br>' +
    x(eodState.freezerReasonStaffing) + ' Staffing<br>' +
    x(eodState.freezerReasonHighVol) + ' High Volume<br>' +
    x(eodState.freezerReasonOther) + ' Other: ' + esc(eodState.freezerReasonOtherText);
  html += '<tr>' +
    '<td style="' + TH_L + '"><b>If yes, how many, what kind, and why were there samples left over?</b></td>' +
    '<td style="' + TD + '"><b>No. of Samples:</b><br>' + esc(eodState.freezerSamplesNum) + '</td>' +
    '<td style="' + TD + '"><b>Sample Type(s)</b><br>' + esc(eodState.freezerSamplesType) + '</td>' +
    '<td style="' + TD + '"><b>Reason:</b><br>' + fReason + '</td>' +
  '</tr>';

  // Row 5: Remaining on line, left label + 3 sub-columns
  const lReason =
    x(eodState.lineSamplesReasonTrack) + ' Track/Automation<br>' +
    x(eodState.lineSamplesReasonStaffing) + ' Staffing<br>' +
    x(eodState.lineSamplesReasonHighVol) + ' High Volume';
  html += '<tr>' +
    '<td style="' + TH_L + '"><b>Remaining samples on line.</b></td>' +
    '<td style="' + TD + '"><b>No. of samples</b><br>' +
      'BB Complete: ' + esc(eodState.lineSamplesBbComplete) + '<br>' +
      'BB Incomplete: ' + esc(eodState.lineSamplesBbIncomplete) + '<br>' +
      'OP Complete: ' + esc(eodState.lineSamplesOpComplete) + '<br>' +
      'OP Incomplete: ' + esc(eodState.lineSamplesOpIncomplete) +
    '</td>' +
    '<td style="' + TD + '"><b>Departments on Line:</b><br>' + esc(eodState.lineSamplesDept) + '</td>' +
    '<td style="' + TD + '"><b>Reason:</b><br>' + lReason + '</td>' +
  '</tr>';

  // Issue rows: left label bold, content spans 3
  const iRow = (lbl, val) => '<tr>' +
    '<td style="' + TH_L + '"><b>' + lbl + '</b></td>' +
    '<td style="' + TD + '" colspan="3">' + esc(val||'N/A').replace(/\n/g,'<br>') + '</td>' +
  '</tr>';

  html += iRow('BB - BIM Issues', eodState.bbBimIssues);
  html += iRow('OP - BIM Issues', eodState.opBimIssues);
  html += iRow('BB - Issues', eodState.bbIssues);
  html += iRow('OP - Issues', eodState.opIssues);
  html += iRow('BB - HVS Issues', eodState.bbHvsIssues);
  html += iRow('OP - HVS Issues', eodState.opHvsIssues);

  // Maintenance: right side split into OP and BB
  html += '<tr>' +
    '<td style="' + TH_L + '"><b>Maintenance Tasks Completed</b></td>' +
    '<td style="' + TD + '" colspan="2">Optimus Prime &nbsp; ' + x(eodState.maintOpYes) + ' YES &nbsp; ' + x(eodState.maintOpNo) + ' NO</td>' +
    '<td style="' + TD + '">Bumblebee &nbsp; ' + x(eodState.maintBbYes) + ' YES &nbsp; ' + x(eodState.maintBbNo) + ' NO</td>' +
  '</tr>';

  html += iRow('If no, what tasks are remaining?', eodState.maintRemaining);
  html += iRow('Instrument/Module Issues:', eodState.instrumentIssues);

  if(eodState.eodNotes && eodState.eodNotes.trim()){
    const bullets = eodState.eodNotes.split('\n').filter(l=>l.trim())
      .map(l=>'<li style="font-size:12px;font-family:Calibri,Arial,sans-serif">' + esc(l.trim()) + '</li>').join('');
    html += '<tr>' +
      '<td style="' + TH_L + '"><b>Notes</b></td>' +
      '<td style="' + TD + '" colspan="3"><ul style="margin:2px 0 0 18px;padding:0">' + bullets + '</ul></td>' +
    '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

async function eodCopy(){
  const el = document.getElementById('eodRender');
  if(!el) return;
  try {
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="Microsoft Word 15">
<meta name="Originator" content="Microsoft Word 15">
</head>
<body>${el.innerHTML}</body></html>`;
    const text = el.innerText;
    if(navigator.clipboard?.write){
      const blob = new Blob([html], {type:'text/html'});
      const textBlob = new Blob([text], {type:'text/plain'});
      await navigator.clipboard.write([new ClipboardItem({'text/html':blob, 'text/plain':textBlob})]);
    } else {
      const range = document.createRange();
      range.selectNode(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('copy');
      window.getSelection().removeAllRanges();
    }
    showToast('Copied to clipboard. Paste into your email.');
  } catch(e){
    console.warn('Copy failed:',e);
    showToast('Copy failed. Try again.');
  }
}

// Snapshot save reuses the same lsSnapshots collection but with type='eod'
// so they show alongside Line Status snapshots and follow the same purge schedule.
async function eodSaveSnapshot(){
  await db.collection('lsSnapshots').add({
    type: 'eod',
    data: JSON.stringify(eodState),
    submittedBy: user.name,
    role: user.role,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  showToast('EOD snapshot saved.');
}

// ── BUNCH 6: TODAY / PUBLISH SYSTEM ────────────────────────────
// Live shared view of the most recent published Line Status and EOD
// for the current day. The Publish button on the report forms writes
// the form state to a single per-day record in Firestore (one for
// Line Status, one for EOD), and every publish or edit appends to a
// revision history. The Today panel renders the latest published
// version read-only and provides an "Edit & republish" affordance.
//
// This addresses the "live updating shared status" use case raised by
// the Lead team: instead of follow-up emails to correct or update an
// earlier Line Status, the publisher (or anyone) can edit the live
// record and the team sees the new version immediately.

// Currently active Today sub-tab. Persisted across opens so that
// returning to the Today panel picks up where you left off.
let currentTodayTab = 'ls';

// Cached published documents and their revision histories. Populated
// by Firestore subscriptions started when the Today panel is opened.
let todayPublished = { ls: null, eod: null };
let todayRevisions = [];
let todayLsSub = null;
let todayEodSub = null;
let todayRevSub = null;

// Returns a YYYY-MM-DD key for "today" in EST. Used as the document ID
// for per-day published records so all clients agree on which day's
// report they are looking at, regardless of their browser's local
// timezone setting.
function todayKey(){
  const now = new Date();
  // Convert to EST: subtract 5 hours from UTC (year-round; matches the
  // approach used elsewhere in the app for snapshot purge timing)
  const est = new Date(now.getTime() - 5*60*60*1000);
  const y = est.getUTCFullYear();
  const m = String(est.getUTCMonth()+1).padStart(2,'0');
  const d = String(est.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

function openToday(){
  document.getElementById('todayPanel').classList.add('open');
  updateHeaderActiveStates();
  // Subscribe to today's published records and revision history so the
  // view updates in real time as other users publish or edit.
  startTodaySubscriptions();
  switchTodayTab(currentTodayTab);
}

function closeToday(){
  document.getElementById('todayPanel').classList.remove('open');
  updateHeaderActiveStates();
  // Detach subscriptions when the panel is closed to avoid keeping
  // unnecessary realtime listeners alive.
  if(todayLsSub){ todayLsSub(); todayLsSub = null; }
  if(todayEodSub){ todayEodSub(); todayEodSub = null; }
  if(todayRevSub){ todayRevSub(); todayRevSub = null; }
}

function switchTodayTab(tab){
  currentTodayTab = tab;
  document.getElementById('tTabLs').classList.toggle('active', tab==='ls');
  document.getElementById('tTabEod').classList.toggle('active', tab==='eod');
  document.getElementById('tTabHist').classList.toggle('active', tab==='hist');
  if(tab==='ls') renderTodayLs();
  else if(tab==='eod') renderTodayEod();
  else if(tab==='hist') renderTodayHistory();
}

// Realtime subscriptions to today's published records and revision log.
// Each kind (ls, eod) is a single document keyed by todayKey() so there
// is at most one "current" published version of each report per day.
function startTodaySubscriptions(){
  const key = todayKey();
  if(!todayLsSub){
    todayLsSub = db.collection('publishedReports').doc(`ls_${key}`)
      .onSnapshot(doc => {
        const prev = todayPublished.ls;
        todayPublished.ls = doc.exists ? doc.data() : null;
        // If a NEW publish happened (not just an edit by us), and the
        // panel is showing the LS tab, refresh it. Also notify the user
        // if someone else just published.
        if(currentTodayTab==='ls' && document.getElementById('todayPanel')?.classList.contains('open')){
          renderTodayLs();
        }
        if(prev && todayPublished.ls && prev.publishedBy !== todayPublished.ls.publishedBy
           && todayPublished.ls.lastEditedBy !== user?.name){
          showToast(`${todayPublished.ls.lastEditedBy || todayPublished.ls.publishedBy} updated the Line Status.`);
        }
      });
  }
  if(!todayEodSub){
    todayEodSub = db.collection('publishedReports').doc(`eod_${key}`)
      .onSnapshot(doc => {
        todayPublished.eod = doc.exists ? doc.data() : null;
        if(currentTodayTab==='eod' && document.getElementById('todayPanel')?.classList.contains('open')){
          renderTodayEod();
        }
      });
  }
  if(!todayRevSub){
    todayRevSub = db.collection('publishedReports').doc(`ls_${key}`)
      .collection('revisions').orderBy('at','desc').limit(50)
      .onSnapshot(snap => {
        // Combine LS and EOD revisions; we'll re-fetch EOD revisions
        // separately below. For simplicity in this version we only
        // subscribe to the LS document's revisions; EOD revisions are
        // loaded on demand when the History tab is opened.
        todayRevisions = snap.docs.map(d => ({id:d.id, kind:'ls', ...d.data()}));
        if(currentTodayTab==='hist' && document.getElementById('todayPanel')?.classList.contains('open')){
          renderTodayHistory();
        }
      });
  }
}

// Renders the Line Status tab in the Today panel.
function renderTodayLs(){
  const body = document.getElementById('todayBody');
  const pub = todayPublished.ls;
  if(!pub){
    body.innerHTML = todayEmptyState('Line Status');
    return;
  }
  const lastEditTime = pub.lastEditedAt || pub.publishedAt;
  const editedNote = pub.editCount > 1
    ? `<span class="rev-action">(edited ${pub.editCount-1} time${pub.editCount-1===1?'':'s'})</span>`
    : '';
  body.innerHTML = `
    <div class="today-meta">
      <div class="today-meta-left">
        <div><span class="today-meta-by">${esc(pub.lastEditedBy || pub.publishedBy)}</span> ${editedNote}</div>
        <div class="today-meta-time">${fmtTime(lastEditTime)}</div>
      </div>
      <div class="today-meta-actions">
        <button onclick="todayLoadIntoForm('ls')">Edit &amp; republish</button>
        <button onclick="withdrawPublishedReport('ls')" class="withdraw" title="Remove this published report from the Today view (audit-tracked)">Withdraw</button>
      </div>
    </div>
    <div class="ls-render">${pub.renderedHtml || '<i style="color:#777">No content</i>'}</div>
  `;
}

// Renders the EOD tab in the Today panel.
function renderTodayEod(){
  const body = document.getElementById('todayBody');
  const pub = todayPublished.eod;
  if(!pub){
    body.innerHTML = todayEmptyState('EOD');
    return;
  }
  const lastEditTime = pub.lastEditedAt || pub.publishedAt;
  const editedNote = pub.editCount > 1
    ? `<span class="rev-action">(edited ${pub.editCount-1} time${pub.editCount-1===1?'':'s'})</span>`
    : '';
  body.innerHTML = `
    <div class="today-meta">
      <div class="today-meta-left">
        <div><span class="today-meta-by">${esc(pub.lastEditedBy || pub.publishedBy)}</span> ${editedNote}</div>
        <div class="today-meta-time">${fmtTime(lastEditTime)}</div>
      </div>
      <div class="today-meta-actions">
        <button onclick="todayLoadIntoForm('eod')">Edit &amp; republish</button>
        <button onclick="withdrawPublishedReport('eod')" class="withdraw" title="Remove this published report from the Today view (audit-tracked)">Withdraw</button>
      </div>
    </div>
    <div class="ls-render">${pub.renderedHtml || '<i style="color:#777">No content</i>'}</div>
  `;
}

// Renders the revision history tab. Combines revisions from both
// publishedReports/ls_{date}/revisions and publishedReports/eod_{date}/revisions
// so the user can see a unified timeline of who changed what.
async function renderTodayHistory(){
  const body = document.getElementById('todayBody');
  body.innerHTML = '<div style="color:var(--muted);font-style:italic;padding:20px;text-align:center">Loading history...</div>';
  const key = todayKey();
  // Pull both LS and EOD revisions in parallel
  const [lsSnap, eodSnap] = await Promise.all([
    db.collection('publishedReports').doc(`ls_${key}`).collection('revisions').orderBy('at','desc').limit(50).get(),
    db.collection('publishedReports').doc(`eod_${key}`).collection('revisions').orderBy('at','desc').limit(50).get()
  ]);
  const all = [
    ...lsSnap.docs.map(d => ({kind:'ls', ...d.data()})),
    ...eodSnap.docs.map(d => ({kind:'eod', ...d.data()}))
  ].sort((a,b) => (b.at?.toMillis?.()||0) - (a.at?.toMillis?.()||0));

  if(!all.length){
    body.innerHTML = todayEmptyState('Revision History', 'No publishes or edits today yet.');
    return;
  }
  body.innerHTML = `<div class="rev-list">${all.map(r => `
    <div class="rev-item">
      <div class="rev-hdr">
        <span class="rev-type ${r.kind}">${r.kind==='ls'?'Line Status':'EOD'}</span>
        <span class="rev-by">${esc(r.by||'?')}</span>
        <span class="rev-action">${esc(r.action||'published')}</span>
        <span class="rev-time">${fmtTime(r.at)}</span>
      </div>
    </div>
  `).join('')}</div>`;
}

// Empty-state placeholder shown when no published record exists yet.
function todayEmptyState(label, sub){
  return `
    <div class="today-empty">
      <div class="today-empty-ico">${ICONS.inbox}</div>
      <div class="today-empty-title">No ${label} published today</div>
      <div class="today-empty-sub">${sub || 'When someone hits Publish on the ' + label + ' form, it will appear here.'}</div>
    </div>
  `;
}

// Loads a published record back into the form so the publisher (or
// anyone) can make corrections and republish. Closes the Today panel
// and opens Reports on the appropriate sub-tab.
function todayLoadIntoForm(kind){
  if(kind==='ls'){
    const pub = todayPublished.ls;
    if(!pub) return;
    const data = JSON.parse(pub.data);
    Object.assign(lsState, data);
    lsState.csvOp = null; // CSV file objects are not stored
    lsState.csvBb = null;
    closeToday();
    openReports();
    switchReportTab('ls');
    showToast('Loaded into form. Make changes, then click Publish to update.');
  } else if(kind==='eod'){
    const pub = todayPublished.eod;
    if(!pub) return;
    const data = JSON.parse(pub.data);
    Object.assign(eodState, data);
    closeToday();
    openReports();
    switchReportTab('eod');
    showToast('Loaded into form. Make changes, then click Publish to update.');
  }
}

// Publishes the current Line Status form to the day's shared record.
// If a published record already exists, this is treated as an edit
// rather than a new publish, and the editor metadata is updated. A
// revision row is appended in either case.
// Returns the YYYY-MM-DD date key to attribute this Line Status to,
// using a 05:30 EST cutoff. A report published at or before 05:30 EST
// is attributed to the previous calendar day because late-shift final
// line statuses are often sent just after midnight but still belong
// operationally to the previous day (e.g. a Saturday final sent at
// 02:30 Sunday should be filed under Saturday).
function lsArchiveDayKey(){
  const now = new Date();
  const estOffset = 5 * 60 * 60 * 1000;
  const est = new Date(now.getTime() - estOffset);
  const hours = est.getUTCHours();
  const minutes = est.getUTCMinutes();
  // Before 05:30 EST: attribute to previous calendar day
  if(hours < 5 || (hours === 5 && minutes < 30)){
    est.setUTCDate(est.getUTCDate() - 1);
  }
  const y = est.getUTCFullYear();
  const m = String(est.getUTCMonth() + 1).padStart(2,'0');
  const d = String(est.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

async function lsPublish(){
  const key = todayKey();
  const ref = db.collection('publishedReports').doc(`ls_${key}`);
  const existing = await ref.get();
  const isFinal = lsState.isFinal === true;
  const confirmMsg = existing.exists
    ? `Update the published Line Status?${isFinal ? ' This will also save it permanently to the LS Archive as the final report for the day.' : ''} Everyone on the team will see your edits immediately under the Today tab.`
    : `Publish this Line Status?${isFinal ? ' Since Final is checked, it will also be saved permanently to the LS Archive.' : ''} It will be visible to everyone on the team under the Today tab.`;
  if(!confirm(confirmMsg)) return;

  // Use renderLsHTML() directly so the clean copy-ready output is stored,
  // not the interactive preview HTML which contains delete buttons and inputs.
  const renderedHtml = renderLsHTML();
  const stateCopy = {...lsState};
  delete stateCopy.csvOp;
  delete stateCopy.csvBb;
  const data = JSON.stringify(stateCopy);
  const now = firebase.firestore.FieldValue.serverTimestamp();

  if(existing.exists){
    await ref.update({
      data, renderedHtml,
      lastEditedBy: user.name,
      lastEditedAt: now,
      isFinal,
      editCount: firebase.firestore.FieldValue.increment(1)
    });
    await ref.collection('revisions').add({by:user.name, action: isFinal ? 'edited (final)' : 'edited', at:now});
    showToast(isFinal ? 'Line Status updated and saved to archive.' : 'Line Status updated.');
  } else {
    await ref.set({
      data, renderedHtml,
      publishedBy: user.name, publishedAt: now,
      lastEditedBy: user.name, lastEditedAt: now,
      isFinal, editCount: 1, dateKey: key
    });
    await ref.collection('revisions').add({by:user.name, action: isFinal ? 'published (final)' : 'published', at:now});
    showToast(isFinal ? 'Line Status published and saved to archive.' : 'Line Status published. Visible to all under the Today tab.');
  }

  // If marked Final, write to the permanent lsArchive collection.
  // Uses the day key with 05:30 EST cutoff so late-shift finals are
  // attributed to the correct calendar day.
  if(isFinal){
    const archKey = lsArchiveDayKey();
    await db.collection('lsArchive').doc(archKey).set({
      renderedHtml,
      data,
      date: archKey,
      publishedBy: user.name,
      publishedAt: now,
      // Month key for grouping in the archive viewer (YYYY-MM)
      monthKey: archKey.slice(0, 7)
    });
  }
}

// Same as lsPublish but for the EOD form. Kept as a separate function
// rather than parameterized because the form state objects and DOM
// elements are different; sharing logic via a wrapper would obscure
// more than it would save.
async function eodPublish(){
  const renderEl = document.getElementById('eodRender');
  if(!renderEl) {
    showToast('Open the EOD form before publishing.');
    return;
  }
  const key = todayKey();
  const ref = db.collection('publishedReports').doc(`eod_${key}`);
  const existing = await ref.get();
  const confirmMsg = existing.exists
    ? 'Update the published EOD? Everyone on the team will see your edits immediately under the Today tab.'
    : 'Publish this EOD? It will be visible to everyone on the team under the Today tab.';
  if(!confirm(confirmMsg)) return;

  const renderedHtml = renderEl.innerHTML;
  const data = JSON.stringify(eodState);

  const now = firebase.firestore.FieldValue.serverTimestamp();
  if(existing.exists){
    await ref.update({
      data,
      renderedHtml,
      lastEditedBy: user.name,
      lastEditedAt: now,
      editCount: firebase.firestore.FieldValue.increment(1)
    });
    await ref.collection('revisions').add({
      by: user.name,
      action: 'edited',
      at: now
    });
    showToast('EOD updated.');
  } else {
    await ref.set({
      data,
      renderedHtml,
      publishedBy: user.name,
      publishedAt: now,
      lastEditedBy: user.name,
      lastEditedAt: now,
      editCount: 1,
      dateKey: key
    });
    await ref.collection('revisions').add({
      by: user.name,
      action: 'published',
      at: now
    });
    showToast('EOD published. Visible to all under the Today tab.');
  }
}

// Withdraws a published report from the Today panel. Used when something
// was published in error or contains content that shouldn't remain
// visible to the team (wrong shift, stale info, etc.). Withdrawal is
// audit-tracked: a reason is captured from the user and recorded in
// the revision log alongside the withdrawer's name. The published
// document is deleted from publishedReports/ but the revision history
// subcollection is kept so the audit trail of what happened is intact.
async function withdrawPublishedReport(kind){
  const pub = todayPublished[kind];
  if(!pub){
    showToast('Nothing to withdraw.');
    return;
  }
  const reason = prompt('Reason for withdrawing this report?\n\nThis will be recorded in the revision history.');
  // prompt() returns null on cancel; empty string if the user clicked OK
  // without typing. Both should abort: a reasoned withdrawal is the whole
  // point of this flow.
  if(!reason || !reason.trim()){
    if(reason !== null) showToast('Withdrawal cancelled (no reason given).');
    return;
  }
  const key = todayKey();
  const ref = db.collection('publishedReports').doc(`${kind}_${key}`);
  const now = firebase.firestore.FieldValue.serverTimestamp();
  // Append the withdrawal entry FIRST so the audit log is preserved even
  // if the subsequent delete fails for any reason.
  await ref.collection('revisions').add({
    by: user.name,
    action: `withdrawn: ${reason.trim()}`,
    at: now
  });
  await ref.delete();
  showToast(`${kind === 'ls' ? 'Line Status' : 'EOD'} withdrawn.`);
  // The realtime subscription will pick up the deletion and refresh
  // the Today panel automatically; no manual refresh needed here.
}

// Purges published reports older than 30 days. Runs opportunistically
// at app load alongside the snapshot purge, gated by a per-day cutoff
// timestamp stored in /meta/publishedReports so the cleanup runs at
// most once per day even with many concurrent clients. Revision
// subcollections are deleted alongside their parent documents to
// avoid orphaned records.
async function purgePublishedReportsDaily(){
  try {
    const RETENTION_DAYS = 30;
    const now = new Date();
    const utc = now.getTime();
    const est = new Date(utc - 5*60*60*1000);
    const cutoff = new Date(est);
    cutoff.setUTCHours(6,0,0,0);
    if(est.getUTCHours() < 6){
      cutoff.setUTCDate(cutoff.getUTCDate() - 1);
    }
    const cutoffMs = cutoff.getTime() + 5*60*60*1000;

    // Skip if another client already ran today's purge.
    const metaRef = db.collection('meta').doc('publishedReports');
    const metaSnap = await metaRef.get();
    const lastRun = metaSnap.exists ? (metaSnap.data().lastPurge?.toMillis?.() || 0) : 0;
    if(lastRun >= cutoffMs) return;

    // Calculate the date key threshold for "older than retention window".
    const threshold = new Date(now);
    threshold.setDate(threshold.getDate() - RETENTION_DAYS);
    const ty = threshold.getFullYear();
    const tm = String(threshold.getMonth()+1).padStart(2,'0');
    const td = String(threshold.getDate()).padStart(2,'0');
    const thresholdKey = `${ty}-${tm}-${td}`;

    const old = await db.collection('publishedReports')
      .where('dateKey', '<', thresholdKey).get();
    let deleted = 0;
    for(const doc of old.docs){
      // Delete the revisions subcollection first to avoid orphans.
      const revs = await doc.ref.collection('revisions').get();
      for(const r of revs.docs) await r.ref.delete();
      await doc.ref.delete();
      deleted++;
    }
    await metaRef.set({lastPurge: firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
    if(deleted) console.log(`Purged ${deleted} old published report(s).`);
  } catch(e){
    console.warn('Published report purge failed:', e);
  }
}

// ── SUGGESTIONS ───────────────────────────────────────────────
// A lightweight team feedback channel. Anyone signed in can post a
// suggestion, thumbs-up others' ideas, and see what the team is
// thinking. Leads can mark items closed. Firestore collection:
// suggestions/{id} with fields: text, author, role, createdAt,
// status ('open'|'closed'), closedBy, closedAt, thumbs (string[]).

let suggestSub = null;

function openSuggestions(){
  document.getElementById('suggestPanel').classList.add('open');
  updateHeaderActiveStates();
  renderSuggestions();
}

function closeSuggestions(){
  document.getElementById('suggestPanel').classList.remove('open');
  if(suggestSub){ suggestSub(); suggestSub = null; }
  updateHeaderActiveStates();
}

function renderSuggestions(){
  const body = document.getElementById('suggestBody');
  body.innerHTML = `
    <div class="sug-form">
      <div class="sug-form-lbl">Post a suggestion</div>
      <textarea id="sugText" maxlength="600" placeholder="Feature requests, workflow ideas, things that could work better..."></textarea>
      <div class="sug-form-row">
        <button class="btn btn-p" style="font-size:13px;padding:7px 16px" onclick="submitSuggestion()">Post</button>
      </div>
    </div>
    <div id="sugList"><div style="color:var(--muted);font-style:italic;font-size:13px;padding:10px 0">Loading...</div></div>
  `;

  // Real-time subscription so new suggestions and votes appear live.
  // Ordered by creation time descending so newest are at the top.
  if(suggestSub){ suggestSub(); suggestSub = null; }
  suggestSub = db.collection('suggestions')
    .orderBy('createdAt','desc')
    .onSnapshot(snap => {
      const items = snap.docs.map(d => ({id:d.id, ...d.data()}));
      populateSuggestList(items);
    });
}

function populateSuggestList(items){
  const list = document.getElementById('sugList');
  if(!list) return;

  const open = items.filter(s => s.status !== 'closed');
  const closed = items.filter(s => s.status === 'closed');

  // Leads can close/reopen; everyone can see the button but only
  // Leads and ALOs get the action. Guests are blocked at the write gate.
  const canClose = ['Lead','ALO'].includes(user?.role);

  function cardHTML(s){
    const thumbs = Array.isArray(s.thumbs) ? s.thumbs : [];
    const voted = thumbs.includes(user?.name);
    const isClosed = s.status === 'closed';
    return `
      <div class="sug-card${isClosed?' closed':''}" id="sugCard_${s.id}">
        <div class="sug-card-text">${esc(s.text||'')}</div>
        <div class="sug-card-footer">
          <span class="sug-author">${esc(s.author||'?')}</span>
          <span class="sug-role">${esc(s.role||'')}</span>
          <span class="sug-time">${fmtTime(s.createdAt)}</span>
          <div class="sug-thumbs">
            <button class="sug-thumbs-btn${voted?' voted':''}" onclick="toggleSuggestThumb('${s.id}','${esc(user?.name||'')}',${voted})">
              👍 ${thumbs.length || 0}
            </button>
            ${canClose ? `<button class="sug-close-btn${isClosed?' reopen':''}" onclick="setSuggestClosed('${s.id}',${!isClosed})">${isClosed?'Reopen':'Close'}</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  let html = '';
  if(!open.length && !closed.length){
    html = '<div class="sug-empty">No suggestions yet. Be the first to post one.</div>';
  } else {
    if(open.length){
      html += `<div class="sug-list">${open.map(cardHTML).join('')}</div>`;
    } else {
      html += '<div class="sug-empty" style="padding:20px 0">No open suggestions.</div>';
    }
    if(closed.length){
      html += `<div class="sug-closed-hdr">Closed (${closed.length})</div>`;
      html += `<div class="sug-list">${closed.map(cardHTML).join('')}</div>`;
    }
  }
  list.innerHTML = html;
}

async function submitSuggestion(){
  if(!requireIdentity('post suggestions')) return;
  const text = document.getElementById('sugText')?.value.trim();
  if(!text){ showToast('Type something first.'); return; }
  if(text.length > 600){ showToast('Keep it under 600 characters.'); return; }

  await db.collection('suggestions').add({
    text,
    author: user.name,
    role: user.role,
    status: 'open',
    thumbs: [],
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  const ta = document.getElementById('sugText');
  if(ta) ta.value = '';
  showToast('Suggestion posted.');
}

// Toggles the current user's thumbs-up on a suggestion.
// Adds the user's name to the thumbs array if not already present,
// or removes it if they are (toggle behavior).
async function toggleSuggestThumb(suggId, userName, currentlyVoted){
  if(!requireIdentity('vote on suggestions')) return;
  const ref = db.collection('suggestions').doc(suggId);
  if(currentlyVoted){
    await ref.update({
      thumbs: firebase.firestore.FieldValue.arrayRemove(userName)
    });
  } else {
    await ref.update({
      thumbs: firebase.firestore.FieldValue.arrayUnion(userName)
    });
  }
}

// Closes or reopens a suggestion. Only Leads and ALOs reach this via
// the UI; the button is hidden for Siemens and Guest users.
async function setSuggestClosed(suggId, close){
  if(!requireIdentity('close suggestions')) return;
  const update = close
    ? { status:'closed', closedBy:user.name, closedAt:firebase.firestore.FieldValue.serverTimestamp() }
    : { status:'open', closedBy:firebase.firestore.FieldValue.delete(), closedAt:firebase.firestore.FieldValue.delete() };
  await db.collection('suggestions').doc(suggId).update(update);
}

// ── LS ARCHIVE (Bunch 7) ──────────────────────────────────────
// Viewer for permanent final Line Status records. Organized by month
// then by week (Sunday to Saturday) so the team can quickly find a
// specific shift's final report. Only Line Statuses published with
// the Final toggle are stored here.
//
// Day attribution uses the 05:30 EST cutoff: a final sent at 02:30
// Sunday is stored under Saturday's date key so it sits in the right
// shift's week bucket.

async function renderLsArchive(){
  const body = document.getElementById('reportsBody');
  body.innerHTML = '<div style="color:var(--muted);font-style:italic;padding:30px;text-align:center">Loading archive...</div>';

  const snap = await db.collection('lsArchive').orderBy('date','desc').get();
  const entries = snap.docs.map(d => ({id:d.id, ...d.data()}));

  if(!entries.length){
    body.innerHTML = `
      <div style="padding:40px;text-align:center;color:var(--muted)">
        <div style="font-size:36px;margin-bottom:12px;opacity:.5">${ICONS.archive}</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">No final line statuses yet</div>
        <div style="font-size:13px">When you publish a Line Status with the Final checkbox checked, it will appear here.</div>
      </div>
    `;
    return;
  }

  // Group by month (YYYY-MM) then by week (Sunday-Saturday range)
  const byMonth = {};
  entries.forEach(e => {
    const month = e.monthKey || e.date.slice(0,7);
    if(!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(e);
  });

  // Week range label: given a YYYY-MM-DD date string, return the
  // Sunday-Saturday range that contains it.
  function weekRange(dateStr){
    const d = new Date(dateStr + 'T12:00:00Z');
    const dow = d.getUTCDay(); // 0=Sun
    const sun = new Date(d);
    sun.setUTCDate(d.getUTCDate() - dow);
    const sat = new Date(sun);
    sat.setUTCDate(sun.getUTCDate() + 6);
    const fmt = dt => dt.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
    return `${fmt(sun)} - ${fmt(sat)}`;
  }

  function monthLabel(ym){
    const [y, m] = ym.split('-');
    return new Date(`${y}-${m}-15`).toLocaleDateString('en-US',{month:'long',year:'numeric'});
  }

  function dayLabel(dateStr){
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});
  }

  // Build accordion: months expanded by default, weeks collapsed
  let html = '<div class="lsa-list">';
  Object.keys(byMonth).sort().reverse().forEach(month => {
    const monthEntries = byMonth[month];
    // Group by week within the month
    const byWeek = {};
    monthEntries.forEach(e => {
      const wr = weekRange(e.date);
      if(!byWeek[wr]) byWeek[wr] = [];
      byWeek[wr].push(e);
    });

    html += `
      <div class="lsa-month">
        <div class="lsa-month-hdr" onclick="this.parentElement.classList.toggle('open')">
          <span>${monthLabel(month)}</span>
          <span class="lsa-count">${monthEntries.length} final${monthEntries.length===1?'':'s'}</span>
          <span class="lsa-chev">▾</span>
        </div>
        <div class="lsa-month-body">
    `;

    Object.keys(byWeek).forEach(week => {
      const weekEntries = byWeek[week];
      html += `
        <div class="lsa-week">
          <div class="lsa-week-hdr">${week}</div>
          <div class="lsa-week-body">
            ${weekEntries.map(e => `
              <div class="lsa-entry" onclick="openLsArchiveEntry('${e.id}')">
                <div class="lsa-entry-date">${dayLabel(e.date)}</div>
                <div class="lsa-entry-meta">Published by ${esc(e.publishedBy||'?')} · ${fmtTime(e.publishedAt)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    });

    html += '</div></div>';
  });
  html += '</div>';

  // Open the most recent month by default
  body.innerHTML = html;
  body.querySelector('.lsa-month')?.classList.add('open');
}

// Opens a single archived final Line Status in a full-screen overlay.
// Renders the stored HTML read-only, same as the Today panel viewer.
async function openLsArchiveEntry(dateKey){
  const doc = await db.collection('lsArchive').doc(dateKey).get();
  if(!doc.exists){ showToast('Entry not found.'); return; }
  const entry = doc.data();

  const overlay = document.createElement('div');
  overlay.className = 'panel-overlay open';
  overlay.style.zIndex = '250';
  overlay.innerHTML = `
    <div class="panel" style="max-width:1100px">
      <div class="panel-hdr">
        <div class="panel-title">Final Line Status</div>
        <div style="font-size:13px;color:var(--muted);margin-left:10px">${esc(dateKey)} · Published by ${esc(entry.publishedBy||'?')}</div>
        <button class="mclose" style="margin-left:auto" onclick="this.closest('.panel-overlay').remove()">×</button>
      </div>
      <div class="panel-body">
        <div class="ls-render">${entry.renderedHtml || '<i style="color:var(--muted)">No content stored.</i>'}</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ── BOOT ──────────────────────────────────────────────────────
// Application entry point. Restores theme preference (before any
// rendering, to avoid theme flash), then either shows the user setup
// screen or proceeds to initApp() if the user has been identified
// previously. All async work after this point is event-driven.
// Apply theme before anything else so dark mode persists across reloads (no flash of light)
if(localStorage.getItem('lt_theme') === 'dark') document.documentElement.classList.add('dark');

// Inject all static SVG icons before any user interaction. This covers
// the setup screen (in case user is brand-new) and the main app
// header/hamburger before initApp() runs.
injectStaticIcons();
// Populate the name picker in the setup overlay from the preset roster.
populateSetupNames();

const saved=localStorage.getItem('lt_user');
if(saved){
  user=JSON.parse(saved);
  document.getElementById('setupOverlay').classList.add('hidden');
  initApp();
}
