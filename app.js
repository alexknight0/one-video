import { VERSION } from "./version.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  initializeAuth, browserLocalPersistence, browserPopupRedirectResolver,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc,
  collection, getDocs, writeBatch, Bytes,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCWkYvty0RjkOdq5xJNuOtAWH9Xa9p5uvE",
  authDomain: "one-video-37c315.firebaseapp.com",
  projectId: "one-video-37c315",
  storageBucket: "one-video-37c315.firebasestorage.app",
  messagingSenderId: "121219978533",
  appId: "1:121219978533:web:4da006f8ec8efa7f1eb6cc",
};

// Firestore caps a document at 1 MiB; keep a safe margin for the field overhead.
const CHUNK_BYTES = 900_000;
const VIDEO_DOC = ["video", "current"]; // the single saved video

const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, {
  persistence: browserLocalPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});
const db = getFirestore(app);

// --- DOM ---
const boot = document.getElementById("boot");
const gate = document.getElementById("gate");
const gateMsg = document.getElementById("gate-msg");
const signinBtn = document.getElementById("signin-btn");
const appEl = document.getElementById("app");
const playerWrap = document.getElementById("player-wrap");
const player = document.getElementById("player");
const empty = document.getElementById("empty");
const form = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const pickLabel = document.getElementById("pick-label");
const timeInput = document.getElementById("time-input");
const saveBtn = document.getElementById("save-btn");
const changeBtn = document.getElementById("change-btn");
const progress = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const errorEl = document.getElementById("error");

let currentBlobUrl = null; // object URL of the playing blob, revoked when replaced
let busy = false;          // uploading or downloading

// --- time helpers (same as before) ---
function parseTime(raw) {
  const text = (raw || "").trim().toLowerCase();
  if (!text) return null;
  if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(text)) {
    const parts = text.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    return secs;
  }
  const unit = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (unit && (unit[1] || unit[2] || unit[3])) {
    const h = Number(unit[1] || 0), m = Number(unit[2] || 0), s = Number(unit[3] || 0);
    return h * 3600 + m * 60 + s;
  }
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}
function formatTime(secs) {
  if (!secs || secs < 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// --- UI state ---
function showError(msg) { errorEl.textContent = msg; errorEl.hidden = false; }
function clearError() { errorEl.hidden = true; errorEl.textContent = ""; }

function showProgress(text, frac) {
  progress.hidden = false;
  progressText.textContent = text;
  progressBar.style.width = `${Math.round((frac || 0) * 100)}%`;
}
function hideProgress() { progress.hidden = true; progressBar.style.width = "0%"; }

function showPlayer(blobUrl, startSeconds) {
  if (currentBlobUrl && currentBlobUrl !== blobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = blobUrl;
  player.src = blobUrl;
  if (startSeconds > 0) {
    player.addEventListener("loadedmetadata", () => {
      try { player.currentTime = startSeconds; } catch {}
    }, { once: true });
  }
  playerWrap.hidden = false;
  empty.hidden = true;
  form.hidden = true;
  changeBtn.hidden = false;
  // Autoplay on open (unmuted; browsers may need a tap to start the sound).
  player.play().catch(() => {});
  clearError();
}

function showUploadForm(startSeconds) {
  player.removeAttribute("src");
  player.load();
  playerWrap.hidden = true;
  empty.hidden = false;
  form.hidden = false;
  changeBtn.hidden = true;
  fileInput.value = "";
  pickLabel.textContent = "Choose a video…";
  timeInput.value = startSeconds ? formatTime(startSeconds) : "";
  hideProgress();
  clearError();
}

// --- Firestore storage ---
function videoDocRef() { return doc(db, ...VIDEO_DOC); }
function chunksCol() { return collection(db, ...VIDEO_DOC, "chunks"); }

async function loadSavedVideo() {
  const snap = await getDoc(videoDocRef());
  if (!snap.exists()) return null;
  const meta = snap.data();
  if (!meta.done || !meta.chunks) return { meta, incomplete: true };
  return { meta, incomplete: false };
}

// Fetch all chunks and reassemble into a Blob.
async function downloadVideo(meta) {
  const total = meta.chunks;
  const parts = new Array(total);
  const CONCURRENCY = 4;
  let fetched = 0;
  let next = 0;

  async function worker() {
    while (next < total) {
      const i = next++;
      const id = String(i).padStart(6, "0");
      const cSnap = await getDoc(doc(db, ...VIDEO_DOC, "chunks", id));
      if (!cSnap.exists()) throw new Error(`missing chunk ${i}`);
      parts[i] = cSnap.data().d.toUint8Array();
      fetched++;
      showProgress(`Loading video… ${fetched}/${total}`, fetched / total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  hideProgress();
  return new Blob(parts, { type: meta.type || "video/mp4" });
}

// Delete the old video doc + every chunk. One deleteDoc per chunk (batches cap at 10 MiB).
async function deleteSavedVideo() {
  const existing = await getDocs(chunksCol());
  const CONCURRENCY = 8;
  const docs = existing.docs;
  let next = 0, done = 0;
  async function worker() {
    while (next < docs.length) {
      const d = docs[next++];
      await deleteDoc(d.ref);
      done++;
      showProgress(`Clearing old video… ${done}/${docs.length}`, done / docs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, docs.length || 1) }, worker));
  await deleteDoc(videoDocRef());
}

// Chunk a File and write it to Firestore.
async function uploadVideo(file, startSeconds) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const total = Math.max(1, Math.ceil(buf.length / CHUNK_BYTES));

  // Clear any previous video first so a partial old one can't linger.
  showProgress("Preparing…", 0);
  await deleteSavedVideo();

  // Mark the doc not-done while writing, so an interrupted upload is detectable.
  await setDoc(videoDocRef(), {
    name: file.name,
    type: file.type || "video/mp4",
    size: buf.length,
    chunks: total,
    startSeconds: startSeconds || 0,
    createdAt: Date.now(),
    done: false,
  });

  let written = 0;
  for (let i = 0; i < total; i++) {
    const slice = buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const id = String(i).padStart(6, "0");
    await setDoc(doc(db, ...VIDEO_DOC, "chunks", id), { d: Bytes.fromUint8Array(slice) });
    written++;
    showProgress(`Uploading… ${written}/${total}`, written / total);
  }

  await setDoc(videoDocRef(), { done: true }, { merge: true });
  hideProgress();
  return new Blob([buf], { type: file.type || "video/mp4" });
}

// --- events ---
fileInput.addEventListener("change", () => {
  const f = fileInput.files[0];
  pickLabel.textContent = f ? f.name : "Choose a video…";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  const file = fileInput.files[0];
  if (!file) { showError("Choose a video file first."); return; }
  if (!file.type.startsWith("video/")) { showError("That's not a video file."); return; }

  let startSeconds = 0;
  if (timeInput.value.trim()) {
    const t = parseTime(timeInput.value);
    if (t === null) { showError("Start time should look like 1:30, 90, or 1m30s."); return; }
    startSeconds = t;
  }

  busy = true;
  saveBtn.disabled = true;
  try {
    const blob = await uploadVideo(file, startSeconds);
    showPlayer(URL.createObjectURL(blob), startSeconds);
  } catch (err) {
    console.error(err);
    showError("Upload failed: " + (err?.message || err));
    hideProgress();
  } finally {
    busy = false;
    saveBtn.disabled = false;
  }
});

changeBtn.addEventListener("click", async () => {
  const saved = await loadSavedVideo();
  showUploadForm(saved?.meta?.startSeconds || 0);
});

signinBtn.addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    gateMsg.textContent = "Sign-in failed: " + (err?.code || err?.message || err);
  }
});

// Warn before closing while a transfer is running.
window.addEventListener("beforeunload", (e) => {
  if (busy) { e.preventDefault(); e.returnValue = ""; }
});

// --- auth flow ---
async function onSignedIn() {
  boot.hidden = true;
  gate.hidden = true;
  appEl.hidden = false;
  try {
    const saved = await loadSavedVideo();
    if (saved && !saved.incomplete) {
      const blob = await downloadVideo(saved.meta);
      showPlayer(URL.createObjectURL(blob), saved.meta.startSeconds || 0);
    } else if (saved && saved.incomplete) {
      showUploadForm(saved.meta.startSeconds || 0);
      showError("The last upload didn't finish. Please choose the video again.");
    } else {
      showUploadForm(0);
    }
  } catch (err) {
    console.error(err);
    showUploadForm(0);
    showError("Couldn't load the video: " + (err?.message || err));
  }
}

onAuthStateChanged(auth, (user) => {
  const email = user?.email?.toLowerCase();
  if (user && user.emailVerified && email === "octopus0246@gmail.com") {
    onSignedIn();
  } else if (user) {
    // Signed in with the wrong account.
    boot.hidden = true;
    appEl.hidden = true;
    gate.hidden = false;
    gateMsg.textContent = `${user.email} can't use One Video. Sign out and use the owner account.`;
    signinBtn.textContent = "Sign out";
    signinBtn.onclick = () => signOut(auth);
  } else {
    boot.hidden = true;
    appEl.hidden = true;
    gate.hidden = false;
    gateMsg.textContent = "Sign in to upload and watch your video.";
    signinBtn.textContent = "Sign in with Google";
    signinBtn.onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => {
      gateMsg.textContent = "Sign-in failed: " + (err?.code || err?.message || err);
    });
  }
});

// --- update light (shared pages-common library) ---
import("https://cdn.jsdelivr.net/gh/alexknight0/pages-common@1.0.0/update.js")
  .then(({ initUpdateLight }) => initUpdateLight({
    version: VERSION,
    buttons: "#version",
    beforeUpdate: () => !busy, // don't reload mid-transfer
  }))
  .catch((e) => {
    console.warn("update light:", e);
    for (const b of document.querySelectorAll(".version")) {
      b.dataset.state = "unknown";
      b.title = "Couldn't load the update check (offline?).";
    }
  });
