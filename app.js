import { VERSION } from "./version.js";

// Persist the saved video id in both a cookie (as requested) and localStorage
// (cookies are not sent/readable on the file:// origin and can be flaky on
// some mobile browsers, so localStorage is the reliable fallback).
const COOKIE_NAME = "oneVideoId";
const STORAGE_KEY = "one-video:videoId";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5; // 5 years

const playerWrap = document.getElementById("player-wrap");
const player = document.getElementById("player");
const empty = document.getElementById("empty");
const form = document.getElementById("url-form");
const input = document.getElementById("url-input");
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

function setCookie(id) {
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(id)}; max-age=${COOKIE_MAX_AGE}; path=/; SameSite=Lax`;
}
function readCookie() {
  const match = document.cookie.match(new RegExp("(?:^|; )" + COOKIE_NAME + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function saveId(id) {
  setCookie(id);
  try { localStorage.setItem(STORAGE_KEY, id); } catch {}
}
function loadId() {
  const fromCookie = readCookie();
  if (fromCookie && ID_RE.test(fromCookie)) return fromCookie;
  try {
    const fromStorage = localStorage.getItem(STORAGE_KEY);
    if (fromStorage && ID_RE.test(fromStorage)) return fromStorage;
  } catch {}
  return null;
}

// Autoplay the saved video and hide the URL entry; show "Change video" in the header.
function showVideo(id, { autoplay } = {}) {
  const params = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    rel: "0",
    playsinline: "1",
  });
  player.src = `https://www.youtube-nocookie.com/embed/${id}?${params}`;
  playerWrap.hidden = false;
  empty.hidden = true;
  form.hidden = true;
  changeBtn.hidden = false;
  clearError();
}

// Show the URL entry (either no video yet, or the user pressed "Change video").
function showEntry() {
  player.src = "";
  playerWrap.hidden = true;
  empty.hidden = false;
  form.hidden = false;
  changeBtn.hidden = true;
  input.value = "";
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
  saveId(id);
  // Just-saved video: autoplay so pressing Save starts it immediately.
  showVideo(id, { autoplay: true });
  input.blur();
});

changeBtn.addEventListener("click", showEntry);

// Restore the saved video on load and autoplay it.
const saved = loadId();
if (saved) {
  showVideo(saved, { autoplay: true });
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
