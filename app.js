"use strict";

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
const clearBtn = document.getElementById("clear-btn");
const errorEl = document.getElementById("error");

// Extract an 11-char YouTube video id from the many URL shapes, or a bare id.
function parseVideoId(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  const idRe = /^[A-Za-z0-9_-]{11}$/;
  if (idRe.test(text)) return text;

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
    return id && idRe.test(id) ? id : null;
  }

  if (ytHosts.includes(host)) {
    const v = url.searchParams.get("v");
    if (v && idRe.test(v)) return v;
    // /embed/ID, /shorts/ID, /live/ID, /v/ID
    const m = url.pathname.match(/\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }

  return null;
}

function setCookie(id) {
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(id)}; max-age=${COOKIE_MAX_AGE}; path=/; SameSite=Lax`;
}
function clearCookie() {
  document.cookie = `${COOKIE_NAME}=; max-age=0; path=/; SameSite=Lax`;
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
  if (fromCookie && /^[A-Za-z0-9_-]{11}$/.test(fromCookie)) return fromCookie;
  try {
    const fromStorage = localStorage.getItem(STORAGE_KEY);
    if (fromStorage && /^[A-Za-z0-9_-]{11}$/.test(fromStorage)) return fromStorage;
  } catch {}
  return null;
}
function clearId() {
  clearCookie();
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

function showVideo(id) {
  player.src = `https://www.youtube-nocookie.com/embed/${id}`;
  playerWrap.hidden = false;
  empty.hidden = true;
  clearBtn.hidden = false;
}
function showEmpty() {
  player.src = "";
  playerWrap.hidden = true;
  empty.hidden = false;
  clearBtn.hidden = true;
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
  showVideo(id);
  input.value = "";
  input.blur();
});

clearBtn.addEventListener("click", () => {
  clearId();
  showEmpty();
  clearError();
});

// Restore the saved video on load.
const saved = loadId();
if (saved) {
  showVideo(saved);
} else {
  showEmpty();
}
