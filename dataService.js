// ═════════════════════════════════════════════════════════════════════════
// dataService.js - the single place every database operation lives.
//
// Why this file exists: the rest of the app never talks to Firestore
// directly. It calls the functions below. If the backend ever changes (for
// example to an internal company data platform), only this file needs to be
// rewritten; script.js stays untouched. Each function is a thin wrapper: it
// performs one read or write and returns what the caller needs.
//
// Subscriptions: functions ending in "Sub" set up a real-time listener and
// return the unsubscribe handle. The caller passes a callback that receives
// the data. The callback (what to do with the data) stays in the app; only
// the connection (how to listen) lives here. If a future backend has no
// real-time push, these are the functions that would switch to polling.
//
// Firestore-specific values (server timestamps, atomic increments, field
// deletes) are exposed through the helpers at the top so the app never
// references firebase.firestore.FieldValue directly.
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

// ── Firestore value helpers ────────────────────────────────────────────────
// Thin aliases so the app does not reference firebase.firestore.FieldValue
// directly. A different backend would reimplement these three.
const svModule = firebase.firestore.FieldValue;
function serverTime(){ return svModule.serverTimestamp(); }
function incrementBy(n){ return svModule.increment(n); }
function deleteField(){ return svModule.delete(); }
function arrayAdd(value){ return svModule.arrayUnion(value); }
function arrayRemove(value){ return svModule.arrayRemove(value); }

// Batched multi-document write. Returns an object with set() and commit()
// so the caller can stage several writes and commit them atomically without
// referencing the Firestore batch API directly.
function newBatch(){
  const b = db.batch();
  return {
    set: (ref, data) => b.set(ref, data),
    commit: () => b.commit()
  };
}

// Reads a subcollection ('comments' or 'history') from any doc ref. Used by
// the archive routine, which copies these out of issue docs it is moving.
function getSubcollection(docRef, name){
  return docRef.collection(name).get();
}

// ── Issues ──────────────────────────────────────────────────────────────────
function subscribeIssues(boardId, onData, onError){
  return db.collection('issues').where('boardId','==',boardId)
    .onSnapshot(onData, onError);
}
function addIssue(data){
  return db.collection('issues').add(data);
}
function getIssue(id){
  return db.collection('issues').doc(id).get();
}
function updateIssue(id, update){
  return db.collection('issues').doc(id).update(update);
}
function deleteIssue(id){
  return db.collection('issues').doc(id).delete();
}
function getIssuesByStatus(status){
  return db.collection('issues').where('status','==',status).get();
}
function getAllIssues(){
  return db.collection('issues').get();
}

// ── Issue comments ──────────────────────────────────────────────────────────
function subscribeComments(issueId, onData, onError){
  return db.collection('issues').doc(issueId).collection('comments')
    .orderBy('createdAt')
    .onSnapshot(onData, onError);
}
function addComment(issueId, data){
  return db.collection('issues').doc(issueId).collection('comments').add(data);
}
function commentRef(issueId, commentId){
  return db.collection('issues').doc(issueId).collection('comments').doc(commentId);
}

// ── Issue history ─────────────────────────────────────────────────────────--
function subscribeHistory(issueId, onData, onError){
  return db.collection('issues').doc(issueId).collection('history')
    .orderBy('createdAt','desc')
    .onSnapshot(onData, onError);
}
function addHistory(issueId, data){
  return db.collection('issues').doc(issueId).collection('history').add(data);
}

// ── Boards ────────────────────────────────────────────────────────────────--
function getBoards(){
  return db.collection('boards').get();
}
function addBoard(data){
  return db.collection('boards').add(data);
}
function deleteBoard(id){
  return db.collection('boards').doc(id).delete();
}

// ── Roster ──────────────────────────────────────────────────────────────────
function getRoster(){
  return db.collection('roster').get();
}
function rosterDocRef(name){
  return db.collection('roster').doc(name);
}
function subscribeRoster(onData, onError){
  return db.collection('roster').onSnapshot(onData, onError);
}

// ── Mentions (cross-collection comment listener) ────────────────────────────
function subscribeMentions(userName, onData, onError){
  return db.collectionGroup('comments').where('mentions','array-contains',userName)
    .onSnapshot(onData, onError);
}

// ── Archive ───────────────────────────────────────────────────────────────--
function archiveDocRef(id){
  return db.collection('archive').doc(id);
}
function getArchive(){
  return db.collection('archive').orderBy('archivedAt','desc').get();
}
function getAllArchive(){
  return db.collection('archive').get();
}
function getArchiveOlderThan(dateMs){
  return db.collection('archive').where('archivedAt','<', new Date(dateMs)).get();
}
function getArchiveSub(archId, collection){
  // collection is 'comments' or 'history'
  const ref = db.collection('archive').doc(archId).collection(collection);
  return collection === 'history'
    ? ref.orderBy('createdAt','desc').get()
    : ref.orderBy('createdAt').get();
}

// ── Meta (run timestamps for archive/snapshot/report purges) ────────────────
function metaRef(name){
  return db.collection('meta').doc(name);
}

// ── Line Status snapshots ─────────────────────────────────────────────────--
function addLsSnapshot(data){
  return db.collection('lsSnapshots').add(data);
}
function getLsSnapshots(){
  return db.collection('lsSnapshots').orderBy('createdAt','desc').get();
}
function getLsSnapshot(id){
  return db.collection('lsSnapshots').doc(id).get();
}
function deleteLsSnapshot(id){
  return db.collection('lsSnapshots').doc(id).delete();
}
function getLsSnapshotsOlderThan(dateMs){
  return db.collection('lsSnapshots').where('createdAt','<', new Date(dateMs)).get();
}

// ── Published reports (live shared Line Status / EOD) ───────────────────────-
function publishedReportRef(docId){
  // docId is `ls_${key}` or `eod_${key}`
  return db.collection('publishedReports').doc(docId);
}
function subscribePublishedReport(docId, onData, onError){
  return db.collection('publishedReports').doc(docId).onSnapshot(onData, onError);
}
function subscribeRevisions(docId, onData, onError){
  return db.collection('publishedReports').doc(docId)
    .collection('revisions').orderBy('at','desc').limit(50)
    .onSnapshot(onData, onError);
}
function getRevisions(docId){
  return db.collection('publishedReports').doc(docId)
    .collection('revisions').orderBy('at','desc').limit(50).get();
}
// Adds a revision under a published report. Takes the report's doc ref
// (from publishedReportRef) since callers already hold it.
function addRevisionTo(reportRef, data){
  return reportRef.collection('revisions').add(data);
}
// Reads the revisions subcollection from a report doc ref (used by purge,
// which iterates report docs directly).
function getRevisionsOf(reportRef){
  return reportRef.collection('revisions').get();
}
// Published reports keyed by a string dateKey (YYYY-MM-DD) rather than a
// timestamp. Used by the purge routine to find reports before a cutoff day.
function getPublishedReportsBeforeKey(thresholdKey){
  return db.collection('publishedReports').where('dateKey','<', thresholdKey).get();
}

// ── LS Archive (permanent final Line Status records) ────────────────────────
function setLsArchive(dateKey, data){
  return db.collection('lsArchive').doc(dateKey).set(data);
}
function getLsArchive(){
  return db.collection('lsArchive').orderBy('date','desc').get();
}
function getLsArchiveDoc(dateKey){
  return db.collection('lsArchive').doc(dateKey).get();
}

// ── Suggestions ─────────────────────────────────────────────────────────────
function subscribeSuggestions(onData, onError){
  return db.collection('suggestions').orderBy('createdAt','desc')
    .onSnapshot(onData, onError);
}
function addSuggestion(data){
  return db.collection('suggestions').add(data);
}
function suggestionRef(id){
  return db.collection('suggestions').doc(id);
}
