import { VERSION } from "./version.js";

// Persist the saved video id in both a cookie (as requested) and localStorage
// (cookies are not sent/readable on the file:// origin and can be flaky on
// some mobile browsers, so localStorage is the reliable fallback).
const COOKIE_NAME = "oneVideoId";
const TIME_COOKIE_NAME = "oneVideoStart";
const STORAGE_KEY = "one-video:videoId";
const TIME_STORAGE_KEY = "one-video:startSeconds";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5; // 5 years

const playerWrap = document.getElementById("player-wrap");
const player = document.getElementById("player");
const empty = document.getElementById("empty");
const form = document.getElementById("url-form");
const input = document.getElementById("url-input");
const timeInput = document.getElementById("time-input");
const changeBtn = document.getElementById("change-btn");
const errorEl = document.getElementById("error");

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Extract an 11-char YouTube video id from the many URL shapes, or a bare id.
function parseVideoId(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  if (ID_RE.test(text)) return text;

  let url;
  try {
    url = new URL(text.includes("://") ? text : "https://" + text);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const ytHosts = ["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"];

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && ID_RE.test(id) ? id : null;
  }

  if (ytHosts.includes(host)) {
    const v = url.searchParams.get("v");
    if (v && ID_RE.test(v)) return v;
    // /embed/ID, /shorts/ID, /live/ID, /v/ID
    const m = url.pathname.match(/\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }

  return null;
}

// Parse a start time into whole seconds. Accepts:
//   plain seconds: "90", "90s"
//   clock: "1:30" (m:s), "1:02:03" (h:m:s)
//   units: "1m30s", "2h5m", "1h", "45s"
// Returns a non-negative integer, or null if blank/invalid.
function parseTime(raw) {
  const text = (raw || "").trim().toLowerCase();
  if (!text) return null;

  // clock form h:m:s or m:s
  if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(text)) {
    const parts = text.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    return secs;
  }

  // units form, e.g. 1h2m3s / 1m30s / 45s / 2h
  const unit = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (unit && (unit[1] || unit[2] || unit[3])) {
    const h = Number(unit[1] || 0), m = Number(unit[2] || 0), s = Number(unit[3] || 0);
    return h * 3600 + m * 60 + s;
  }

  // plain integer seconds
  if (/^\d+$/.test(text)) return Number(text);

  return null;
}

// Format whole seconds as a clock string for the input box (e.g. 90 -> "1:30").
function formatTime(secs) {
  if (!secs || secs < 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Pull a start time (in seconds) out of a pasted YouTube URL's t=/start= param or #t= fragment.
function parseUrlStart(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text.includes("://") ? text : "https://" + text);
  } catch {
    return null;
  }
  const candidate =
    url.searchParams.get("t") ||
    url.searchParams.get("start") ||
    (url.hash.match(/[#&]t=([^&]+)/)?.[1] ?? null);
  if (!candidate) return null;
  // YouTube's t= can be "90", "90s" or "1m30s"; parseTime handles all of these.
  return parseTime(decodeURIComponent(candidate));
}

function setCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${COOKIE_MAX_AGE}; path=/; SameSite=Lax`;
}
function readCookie(name) {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function saveVideo(id, startSeconds) {
  setCookie(COOKIE_NAME, id);
  setCookie(TIME_COOKIE_NAME, String(startSeconds || 0));
  try {
    localStorage.setItem(STORAGE_KEY, id);
    localStorage.setItem(TIME_STORAGE_KEY, String(startSeconds || 0));
  } catch {}
}
function loadVideo() {
  let id = readCookie(COOKIE_NAME);
  let start = readCookie(TIME_COOKIE_NAME);
  if (!id || !ID_RE.test(id)) {
    try {
      id = localStorage.getItem(STORAGE_KEY);
      start = localStorage.getItem(TIME_STORAGE_KEY);
    } catch {}
  }
  if (!id || !ID_RE.test(id)) return null;
  const startSeconds = Number(start);
  return { id, startSeconds: Number.isFinite(startSeconds) && startSeconds > 0 ? startSeconds : 0 };
}

// Autoplay the saved video and hide the URL entry; show "Change video" in the header.
function showVideo(id, { autoplay, startSeconds } = {}) {
  const params = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    rel: "0",
    playsinline: "1",
  });
  if (startSeconds > 0) params.set("start", String(startSeconds));
  player.src = `https://www.youtube-nocookie.com/embed/${id}?${params}`;
  playerWrap.hidden = false;
  empty.hidden = true;
  form.hidden = true;
  changeBtn.hidden = false;
  clearError();
}

// Show the URL entry (either no video yet, or the user pressed "Change video").
// Prefill with the currently-saved video so it's easy to just tweak the start time.
function showEntry() {
  player.src = "";
  playerWrap.hidden = true;
  empty.hidden = false;
  form.hidden = false;
  changeBtn.hidden = true;
  const current = loadVideo();
  input.value = current ? `https://youtu.be/${current.id}` : "";
  timeInput.value = current && current.startSeconds ? formatTime(current.startSeconds) : "";
  clearError();
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  clearError();
  const id = parseVideoId(input.value);
  if (!id) {
    showError("That doesn't look like a YouTube video URL.");
    return;
  }
  // Explicit start-time field wins; otherwise use any timestamp in the pasted URL.
  let startSeconds;
  if (timeInput.value.trim()) {
    startSeconds = parseTime(timeInput.value);
    if (startSeconds === null) {
      showError("Start time should look like 1:30, 90, or 1m30s.");
      return;
    }
  } else {
    startSeconds = parseUrlStart(input.value) || 0;
  }
  saveVideo(id, startSeconds);
  // Just-saved video: autoplay so pressing Save starts it immediately.
  showVideo(id, { autoplay: true, startSeconds });
  input.blur();
});

changeBtn.addEventListener("click", showEntry);

// Restore the saved video on load and autoplay it.
const saved = loadVideo();
if (saved) {
  showVideo(saved.id, { autoplay: true, startSeconds: saved.startSeconds });
} else {
  showEntry();
}

// Version check: the update light is shared by Alex's Pages sites
// (github.com/alexknight0/pages-common). Loaded dynamically so the site still works if
// jsDelivr is unreachable.
import("https://cdn.jsdelivr.net/gh/alexknight0/pages-common@1.0.0/update.js")
  .then(({ initUpdateLight }) => initUpdateLight({
    version: VERSION,
    buttons: "#version",
  }))
  .catch((e) => {
    console.warn("update light:", e);
    for (const b of document.querySelectorAll(".version")) {
      b.dataset.state = "unknown";
      b.title = "Couldn't load the update check (offline?).";
    }
  });
