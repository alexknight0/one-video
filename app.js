import { VERSION } from "./version.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  initializeAuth, browserLocalPersistence, browserPopupRedirectResolver,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

// Shares the lecture player's Firebase project (Blaze plan) for sign-in and the details doc
// (Firestore oneVideo/current, rules in ~/projects/lecture-player/firestore.rules). The video file
// itself is in Cloudflare R2, which has no download fees, behind the Worker in worker/: it checks
// the caller's Firebase ID token against those same Firestore rules, takes uploads in parts and
// hands out 12-hour playback links that the browser streams with Range requests.
const firebaseConfig = {
  apiKey: "AIzaSyDgEbqEwI9KHnFlBLRJ8RQIgdntISQPty0",
  authDomain: "lecture-player-d77815.firebaseapp.com",
  projectId: "lecture-player-d77815",
  appId: "1:905522641482:web:f737cbe4b19eeead1a04b3",
};
const WORKER = "https://one-video.alexknight0.workers.dev";
const PARALLEL_PARTS = 3; // parts uploaded at once

const VIDEO_DOC = ["oneVideo", "current"]; // the single saved video's details

// A named app keeps this sign-in separate from the lecture player's (same project and API key,
// same origin), so signing out here doesn't sign the lecture player out.
const app = initializeApp(firebaseConfig, "one-video");
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

let currentBlobUrl = null; // object URL of a just-uploaded local file, revoked when replaced
let busy = false;          // uploading
let isOwner = false;       // Alex: may change the video. Others on the watch list only watch it.

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

// src is a Worker playback link (the browser streams it with range requests, so playback
// starts once the part around the start time has arrived), or a local object URL right after an
// upload. The #t= media fragment makes the browser begin loading at the start time.
function showPlayer(src, startSeconds) {
  if (currentBlobUrl && currentBlobUrl !== src) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = src.startsWith("blob:") ? src : null;
  player.src = startSeconds > 0 ? `${src}#t=${startSeconds}` : src;
  if (startSeconds > 0) {
    // Fallback for browsers that ignore the fragment.
    player.addEventListener("loadedmetadata", () => {
      if (player.currentTime < startSeconds - 1) {
        try { player.currentTime = startSeconds; } catch {}
      }
    }, { once: true });
  }
  playerWrap.hidden = false;
  empty.hidden = true;
  form.hidden = true;
  changeBtn.hidden = !isOwner;
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

// --- storage (R2 through the Worker) ---
function videoDocRef() { return doc(db, ...VIDEO_DOC); }

// The doc is written only once the file is fully in R2. A doc without a key is an older format
// (Firestore chunks or Firebase Storage) and is treated as "no usable video".
async function loadSavedVideo() {
  const snap = await getDoc(videoDocRef());
  if (!snap.exists()) return null;
  const meta = snap.data();
  return { meta, incomplete: !meta.key };
}

const formatMB = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

async function worker(method, path, body, extraHeaders = {}) {
  const token = await auth.currentUser.getIdToken();
  const isJson = body !== undefined && !(body instanceof Blob);
  const res = await fetch(WORKER + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(isJson ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
    body: isJson ? JSON.stringify(body) : body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// A fresh 12-hour playback link for the saved video (watchers and Alex).
async function playbackUrl() {
  return (await worker("POST", "/play")).url;
}

// Upload in parts (a Worker request is capped at 100 MB), a few at once, then point the
// Firestore doc at the new object, then delete the previous one. A new key per upload means a
// cached copy of the old video is never reused, and a failed upload leaves the old one playing.
async function uploadVideo(file, startSeconds) {
  const previous = (await loadSavedVideo())?.meta;
  const type = file.type || "video/mp4";
  const { key, uploadId, partBytes } = await worker("POST", "/upload/start", { name: file.name, type, size: file.size });
  const count = Math.max(1, Math.ceil(file.size / partBytes));
  const parts = new Array(count);
  const sent = new Array(count).fill(0);
  const report = () => {
    const done = sent.reduce((a, b) => a + b, 0);
    showProgress(`Uploading… ${formatMB(done)} of ${formatMB(file.size)} (${Math.round(done / file.size * 100)}%)`, done / file.size);
  };
  report();

  let next = 0;
  async function sendParts() {
    while (next < count) {
      const i = next++;
      const blob = file.slice(i * partBytes, (i + 1) * partBytes);
      for (let attempt = 1; ; attempt++) {
        try {
          parts[i] = await worker("PUT", `/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${i + 1}`, blob);
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      sent[i] = blob.size;
      report();
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, count) }, sendParts));
    await worker("POST", "/upload/complete", { key, uploadId, parts });
  } catch (err) {
    await worker("POST", "/upload/abort", { key, uploadId }).catch(() => {});
    throw err;
  }

  await setDoc(videoDocRef(), {
    name: file.name, type, size: file.size, key,
    startSeconds: startSeconds || 0, createdAt: Date.now(), done: true,
  });
  if (previous?.key && previous.key !== key) {
    await worker("DELETE", `/object?key=${encodeURIComponent(previous.key)}`).catch((err) => console.warn("old video not deleted:", err));
  }
  hideProgress();
}

// Playback links expire after 12 hours: if the video errors (e.g. seeking after that), get a new
// link and carry on from the same place.
let refreshing = false;
player.addEventListener("error", async () => {
  if (refreshing || !player.src || player.src.startsWith("blob:") || !auth.currentUser) return;
  refreshing = true;
  const at = player.currentTime;
  try {
    player.src = await playbackUrl();
    player.addEventListener("loadedmetadata", () => { try { player.currentTime = at; } catch {} }, { once: true });
    player.play().catch(() => {});
  } catch (err) {
    showError("Couldn't load the video: " + (err?.message || err));
  } finally {
    setTimeout(() => { refreshing = false; }, 5000);
  }
});

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
    await uploadVideo(file, startSeconds);
    // Play the local file straight away; the next open streams it from R2.
    showPlayer(URL.createObjectURL(file), startSeconds);
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
// Watchers (config/access.emails, edited on Home's Access page) only see the video. Nothing in
// the app says who is on that list: the Firestore rules answer, with permission-denied.
function showWatcherEmpty(text) {
  player.removeAttribute("src");
  playerWrap.hidden = true;
  form.hidden = true;
  changeBtn.hidden = true;
  empty.hidden = false;
  empty.textContent = text;
}

function showNotAllowed(user) {
  boot.hidden = true;
  appEl.hidden = true;
  gate.hidden = false;
  gateMsg.textContent = `${user.email} can't use One Video. Sign out and use an account that's been given access.`;
  signinBtn.textContent = "Sign out";
  signinBtn.onclick = () => signOut(auth);
}

async function onSignedIn(user) {
  let saved;
  try {
    saved = await loadSavedVideo();
  } catch (err) {
    if (err?.code === "permission-denied") { showNotAllowed(user); return; }
    saved = err;
  }
  boot.hidden = true;
  gate.hidden = true;
  appEl.hidden = false;
  if (!isOwner) {
    if (saved instanceof Error) { showWatcherEmpty("Couldn't load the video: " + (saved.message || saved)); return; }
    if (!saved || saved.incomplete) { showWatcherEmpty("There's no video to watch yet."); return; }
    try {
      showPlayer(await playbackUrl(), saved.meta.startSeconds || 0);
    } catch (err) {
      console.error(err);
      showWatcherEmpty("Couldn't load the video: " + (err?.message || err));
    }
    return;
  }
  try {
    if (saved instanceof Error) throw saved;
    if (saved && !saved.incomplete) {
      showPlayer(await playbackUrl(), saved.meta.startSeconds || 0);
    } else if (saved && saved.incomplete) {
      showUploadForm(saved.meta.startSeconds || 0);
      showError("The saved video needs uploading again. Please choose it below.");
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
  isOwner = Boolean(user && user.emailVerified && email === "octopus0246@gmail.com");
  if (user) {
    onSignedIn(user);
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
