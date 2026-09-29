const STORAGE_KEYS = {
  mine: "hl_mineHighlights_v2",
  activeTool: "hl_activeTool_v1",
  deviceKey: "hl_deviceKey_v1"
};

function getDeviceKey() {
  let k = localStorage.getItem(STORAGE_KEYS.deviceKey);
  if (!k) {
    k = (crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    localStorage.setItem(STORAGE_KEYS.deviceKey, k);
  }
  return k;
}

let TOOLS = []; // from highlights.json
let HEAT = { maxCountForFull: 6, minAlpha: 0.10, maxAlpha: 0.55 };

let rawText = "";
let mineHighlights = [];
let communityHighlights = [];
let viewMode = "mine";

let activeToolId = null; // selected tool

const el = (id) => document.getElementById(id);

//const API_BASE = "http://127.0.0.1:8000"; 
const API_BASE = "https://highlight-backend.onrender.com";
function getApiBase() {
  return API_BASE;
}


function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  window.clearTimeout(toast._timer);
  toast._timer = window.setTimeout(() => t.classList.remove("show"), 1600);
}




function loadMine() {
  try {
    mineHighlights = JSON.parse(localStorage.getItem(STORAGE_KEYS.mine) || "[]");
    if (!Array.isArray(mineHighlights)) mineHighlights = [];
  } catch {
    mineHighlights = [];
  }
}
function saveMine() {
  localStorage.setItem(STORAGE_KEYS.mine, JSON.stringify(mineHighlights));
}

function loadActiveToolId() {
  return (localStorage.getItem(STORAGE_KEYS.activeTool) || "").trim() || null;
}
function saveActiveToolId(id) {
  localStorage.setItem(STORAGE_KEYS.activeTool, id);
}

function sanitizeHighlight(h) {
  const ok =
    h && Number.isInteger(h.start) && Number.isInteger(h.end) &&
    h.start >= 0 && h.end > h.start &&
    typeof h.colorId === "string" && h.colorId.length > 0;

  if (!ok) return null;

  // Ensure quote exists (optional for overlap/ticketing)
  if (typeof h.quote !== "string") h.quote = "";

  return h;
}

function toolById(id) {
  return TOOLS.find(t => t.id === id) || null;
}

function selectionToOffsets() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const container = el("textLayer");
  if (!container.contains(range.commonAncestorContainer)) return null;

  const selectedText = sel.toString();
  if (!selectedText || selectedText.trim().length === 0) return null;

  // Insert temporary markers to compute exact offsets in container.textContent
  const startMarker = document.createElement("span");
  const endMarker = document.createElement("span");
  startMarker.id = "__hl_start";
  endMarker.id = "__hl_end";
  startMarker.style.cssText = "display:inline; position:relative; width:0; height:0;";
  endMarker.style.cssText = "display:inline; position:relative; width:0; height:0;";

  const r1 = range.cloneRange();
  r1.collapse(true);
  r1.insertNode(startMarker);

  const r2 = range.cloneRange();
  r2.collapse(false);
  r2.insertNode(endMarker);

  // Now compute offsets by walking textContent up to markers
  const text = container.textContent; // should match rawText exactly
  const beforeStart = text.split("__MARKER_START__").join(""); // not used, just clarity

  // We can't rely on split by id, so compute by Range-toString again but anchored:
  const preStart = document.createRange();
  preStart.selectNodeContents(container);
  preStart.setEndBefore(startMarker);
  const start = preStart.toString().length;

  const preEnd = document.createRange();
  preEnd.selectNodeContents(container);
  preEnd.setEndBefore(endMarker);
  const end = preEnd.toString().length;

  // Cleanup markers
  startMarker.remove();
  endMarker.remove();

  return { start, end, quote: selectedText };
}

function escapeHtml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function hexToRgb(hex) {
  const h = hex.replace("#", "").trim();
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return { r, g, b };
  }
  if (h.length === 6) {
    const r = parseInt(h.slice(0,2), 16);
    const g = parseInt(h.slice(2,4), 16);
    const b = parseInt(h.slice(4,6), 16);
    return { r, g, b };
  }
  return { r: 255, g: 255, b: 0 };
}

function alphaForCount(count) {
  const c = Math.max(0, count);
  const max = Math.max(1, HEAT.maxCountForFull || 6);
  const t = Math.min(1, c / max);
  return (HEAT.minAlpha || 0.10) + t * ((HEAT.maxAlpha || 0.55) - (HEAT.minAlpha || 0.10));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function alphaForColorCount(count) {
  if (count <= 0) return 0;

  const maxCount = Math.max(1, Number(HEAT.maxCountForFull) || 6);
  const minAlpha = Number(HEAT.minAlpha) || 0.10;
  const maxAlpha = Number(HEAT.maxAlpha) || 0.55;

  // First highlight starts at minAlpha. Repeated highlights deepen the color.
  const t = Math.min(1, (count - 1) / Math.max(1, maxCount - 1));
  return clamp01(minAlpha + t * (maxAlpha - minAlpha));
}

function buildColorCoverage(textLen, highlights) {
  // One difference array per color:
  // Map<colorId, number[textLen + 1]>
  const diffs = new Map();

  for (const h of highlights) {
    if (!h) continue;

    const start = Math.max(0, Math.min(textLen, h.start));
    const end = Math.max(0, Math.min(textLen, h.end));
    if (end <= start) continue;

    if (!diffs.has(h.colorId)) {
      diffs.set(h.colorId, new Array(textLen + 1).fill(0));
    }

    const diff = diffs.get(h.colorId);
    diff[start] += 1;
    diff[end] -= 1;
  }

  // Convert differences into running counts.
  const coverage = new Map();

  for (const [colorId, diff] of diffs) {
    const counts = new Array(textLen);
    let running = 0;

    for (let i = 0; i < textLen; i++) {
      running += diff[i];
      counts[i] = running;
    }

    coverage.set(colorId, counts);
  }

  return coverage;
}

function compositeColors(layers) {
  /*
   * Alpha-composite all active colors over a transparent background.
   * Each layer is { r, g, b, a }.
   *
   * The result can then be used as rgba(...). Because the browser draws that
   * RGBA over the page, this preserves both color mixing and transparency.
   */
  let premultipliedR = 0;
  let premultipliedG = 0;
  let premultipliedB = 0;
  let outputAlpha = 0;

  for (const layer of layers) {
    const a = clamp01(layer.a);
    if (a <= 0) continue;

    // "Source over" compositing.
    premultipliedR = layer.r * a + premultipliedR * (1 - a);
    premultipliedG = layer.g * a + premultipliedG * (1 - a);
    premultipliedB = layer.b * a + premultipliedB * (1 - a);
    outputAlpha = a + outputAlpha * (1 - a);
  }

  if (outputAlpha <= 0) return null;

  return {
    r: Math.round(premultipliedR / outputAlpha),
    g: Math.round(premultipliedG / outputAlpha),
    b: Math.round(premultipliedB / outputAlpha),
    a: outputAlpha
  };
}

function colorAt(index, colorCoverage) {
  const layers = [];

  // TOOLS order gives deterministic compositing.
  for (const tool of TOOLS) {
    if (tool.id === "clear") continue;

    const count = colorCoverage.get(tool.id)?.[index] || 0;
    if (count <= 0) continue;

    const { r, g, b } = hexToRgb(tool.color);
    layers.push({
      r,
      g,
      b,
      a: alphaForColorCount(count)
    });
  }

  // Render unknown color IDs too, with a yellow fallback.
  for (const [colorId, counts] of colorCoverage) {
    if (TOOLS.some(tool => tool.id === colorId)) continue;

    const count = counts[index] || 0;
    if (count <= 0) continue;

    const { r, g, b } = hexToRgb("#f59e0b");
    layers.push({
      r,
      g,
      b,
      a: alphaForColorCount(count)
    });
  }

  const mixed = compositeColors(layers);
  if (!mixed) return null;

  return `rgba(${mixed.r},${mixed.g},${mixed.b},${mixed.a.toFixed(3)})`;
}

function renderHeat(text, highlights) {
  const len = text.length;
  if (len === 0) return "";

  const cleanHighlights = highlights
    .map(sanitizeHighlight)
    .filter(Boolean);

  if (cleanHighlights.length === 0) {
    return escapeHtml(text);
  }

  const colorCoverage = buildColorCoverage(len, cleanHighlights);

  let out = "";
  let i = 0;

  while (i < len) {
    const background = colorAt(i, colorCoverage);
    let j = i + 1;

    // Group adjacent characters having the same mixed color.
    while (j < len && colorAt(j, colorCoverage) === background) {
      j++;
    }

    const segment = escapeHtml(text.slice(i, j));

    if (!background) {
      out += segment;
    } else {
      out +=
        `<span class="heatmark" ` +
        `style="background-color:${background}">${segment}</span>`;
    }

    i = j;
  }

  return out;
}

function render() {
  const hl = el("hlLayer");

  if (viewMode === "clean") {
    hl.innerHTML = "";   // no highlights, text remains
    return;
  }

  const mine = mineHighlights.map(sanitizeHighlight).filter(Boolean);
  const comm = communityHighlights.map(sanitizeHighlight).filter(Boolean);

  let combined = [];
  if (viewMode === "mine") {
  combined = mine;
}

if (viewMode === "community") {
  // Use this if GET /highlights returns everybody's highlights,
  // including highlights from the current device.
  combined = comm;
}

  hl.innerHTML = renderHeat(rawText, combined);
}

async function loadText() {
  const res = await fetch("text.txt", { cache: "no-store" });
  rawText = await res.text();
  el("textLayer").textContent = rawText;  // stays constant, no blink
  render(); // only updates highlight layer
}

async function loadTools() {
  const res = await fetch("highlights.json", { cache: "no-store" });
  const cfg = await res.json();
  TOOLS = (cfg.tools || []).filter(t => t && t.id && t.label && t.color);
  HEAT = cfg.heat || HEAT;

  // Default tool: first non-clear
  const first = TOOLS.find(t => t.id !== "clear");
  // Pick active tool: use saved if valid; else default to first non-clear
const saved = loadActiveToolId();
const savedIsValid = saved && TOOLS.some(t => t.id === saved);
if (savedIsValid) {
  activeToolId = saved;
} else {
  const first = TOOLS.find(t => t.id !== "clear");
  activeToolId = first ? first.id : (TOOLS[0]?.id ?? null);
  if (activeToolId) saveActiveToolId(activeToolId);
}
}

function highlightKey(h) {
  return [
    h.deviceKey || "",
    h.originStart ?? h.start,
    h.originEnd ?? h.end,
    h.start,
    h.end,
    h.colorId
  ].join("|");
}

function dedupeHighlights(highlights) {
  const seen = new Set();

  return highlights.filter(h => {
    const key = highlightKey(h);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

if (viewMode === "community") {
  combined = dedupeHighlights([...comm, ...mine]);
}

function buildPalette() {
  const p = el("palette");
  p.innerHTML = "";

  for (const t of TOOLS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool-btn";
    b.dataset.toolId = t.id;

    b.innerHTML = `
      <div>
        <span class="swatch" style="background:${t.color}"></span>
        <span class="label">${t.label}</span>
      </div>
    `;

    b.addEventListener("click", () => setActiveTool(t.id));
    p.appendChild(b);
  }

  refreshPaletteSelectedState();
}

function setActiveTool(id) {
  activeToolId = id;
  saveActiveToolId(id);
  refreshPaletteSelectedState();
  toast(id === "clear" ? "Clear tool selected." : `Selected: ${toolById(id)?.label ?? id}`);
}

function refreshPaletteSelectedState() {
  document.querySelectorAll(".tool-btn").forEach(btn => {
    const isSel = btn.dataset.toolId === activeToolId;
    btn.classList.toggle("selected", isSel);
  });
}

async function postCommunityHighlight(h) {
  const apiBase = getApiBase();
  if (!apiBase) return { ok: false, skipped: true };

  const base = apiBase.replace(/\/+$/, "");
  const resp = await fetch(`${base}/highlights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(h)
  });
  if (!resp.ok) throw new Error(await resp.text());
  return { ok: true };
}

function addMineHighlight(h) {
  mineHighlights.push(h);
  saveMine();
}

function overlapsAnyMine(start, end) {
  return mineHighlights.some(h =>
    h && Number.isInteger(h.start) && Number.isInteger(h.end) &&
    (h.start < end && start < h.end)   // overlap test
  );
}

function clearMineRange(start, end) {
    
  const removedPieces = { deleted: 0, trimmed: 0, split: 0 };

  const next = [];
  for (const hRaw of mineHighlights) {
    const h = sanitizeHighlight(hRaw);
    if (!h) continue;

    // no overlap
    if (!(h.start < end && start < h.end)) {
      next.push(hRaw);
      continue;
    }

    // selection fully covers highlight -> delete
    if (start <= h.start && h.end <= end) {
      removedPieces.deleted += 1;
      continue;
    }

    
    // overlap on left side -> keep right remainder
if (start <= h.start && end < h.end) {
  const oldEnd = h.end;
  const nh = { ...h, start: end, quote: rawText.slice(end, oldEnd) };
  if (nh.end > nh.start) {
    next.push(nh);
    removedPieces.trimmed += 1;
  }
  continue;
}

    // overlap on right side -> keep left remainder
    if (h.start < start && h.end <= end) {
      const nh = { ...h, end: start, quote: rawText.slice(h.start, start) };
      if (nh.end > nh.start) {
        next.push(nh);
        removedPieces.trimmed += 1;
      }
      continue;
    }

    // selection in middle -> split into left + right
    // h.start < start < end < h.end
    if (h.start < start && end < h.end) {
      const left = { ...h, end: start, quote: rawText.slice(h.start, start) };
      const right = { ...h, start: end, quote: rawText.slice(end, h.end) };
      if (left.end > left.start) next.push(left);
      if (right.end > right.start) next.push(right);
      removedPieces.split += 1;
      continue;
    }

    // fallback: if something odd happens, keep nothing
    removedPieces.deleted += 1;
  }

  mineHighlights = next;
  saveMine();
  return removedPieces;
}

async function handleSelectionAction() {
  const sel = selectionToOffsets();
  if (!sel) return;

  if (!activeToolId) { toast("Select a tool first."); return; }

  const start = sel.start;
  const end = sel.end;
  const colorId = activeToolId;

  // CLEAR tool: remove only selected portion from *mine*
if (colorId === "clear") {
  // 1) Clear locally (trim/split) so your view updates immediately
  const r = clearMineRange(start, end);

  // 2) Tell backend to erase ONLY highlights created by this deviceKey
  try {
    await eraseCommunityRange(start, end);
    await refreshCommunity();
  } catch (e) {
    console.warn("Community erase failed:", e);
  }

  window.getSelection()?.removeAllRanges();
  render();

  const total = r.deleted + r.trimmed + r.split;
  toast(total ? "Cleared selected text from your highlights." : "No local highlights to clear there.");
  return;
}

  // Block any overlap with existing mine highlights
  if (overlapsAnyMine(start, end)) {
    window.getSelection()?.removeAllRanges();
    toast("That selection overlaps text you've already highlighted. Clear it first to re-highlight.");
    return;
  }

const h = {
  start, end, quote: sel.quote, colorId,
  deviceKey: getDeviceKey(),
  originStart: start,
  originEnd: end
};

  // Save locally
  addMineHighlight(h);

  // Immediately add to the in-memory community view.
addCommunityHighlightIfMissing(h);

// Render now instead of waiting for the network.
window.getSelection()?.removeAllRanges();
render();

// Save to backend.
try {
  console.log("POSTing to community:", getApiBase(), h);
  await postCommunityHighlight(h);
} catch (e) {
  console.warn("Community save failed:", e);
  toast("Highlight saved locally, but community sync failed.");
}

// Save to community
try {
  console.log("POSTing to community:", getApiBase(), h);
  await postCommunityHighlight(h);

  // Add it immediately to the in-memory community view.
  communityHighlights.push(h);
} catch (e) {
  console.warn("Community save failed:", e);
}

  window.getSelection()?.removeAllRanges();
  render();
}

function sameHighlight(a, b) {
  return (
    a.deviceKey === b.deviceKey &&
    a.start === b.start &&
    a.end === b.end &&
    a.colorId === b.colorId
  );
}

function addCommunityHighlightIfMissing(h) {
  if (!communityHighlights.some(existing => sameHighlight(existing, h))) {
    communityHighlights.push(h);
  }
}

async function eraseCommunityRange(start, end) {
  const base = getApiBase().replace(/\/+$/, "");
  const resp = await fetch(`${base}/highlights/erase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceKey: getDeviceKey(), start, end })
  });
  if (!resp.ok) throw new Error(await resp.text());
  return await resp.json();
}

try {
  console.log("POSTing to community:", getApiBase(), h);
  await postCommunityHighlight(h);
  addCommunityHighlightIfMissing(h);
} catch (e) {
  console.warn("Community save failed:", e);
}

window.getSelection()?.removeAllRanges();
render();

async function deleteOneCommunityExact(start, end, colorId) {
  const base = getApiBase().replace(/\/+$/, "");
  const resp = await fetch(`${base}/highlights/delete_one_exact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start, end, colorId })
  });
  if (!resp.ok) throw new Error(await resp.text());
  return await resp.json(); // {ok:true, deleted:0|1}
}

async function refreshCommunity() {
  const apiBase = getApiBase();
  if (!apiBase) { toast("Set API base first."); return; }
  try {
    const base = apiBase.replace(/\/+$/, "");
    const resp = await fetch(`${base}/highlights`, { cache: "no-store" });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    communityHighlights = Array.isArray(data) ? data : (data.highlights || []);
    render();
  } catch (e) {
    console.warn(e);
    toast("Failed to load community highlights.");
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el("pwModal")?.classList.contains("show")) closePwModal();
});

function wireUi() {


  // View toggles
  document.querySelectorAll('input[name="viewMode"]').forEach(radio => {
  radio.addEventListener("change", async () => {
    viewMode =
      document.querySelector('input[name="viewMode"]:checked')?.value || "mine";

    // Render immediately using existing data.
    render();

    // Fetch current highlights once whenever Community is selected.
    if (viewMode === "community") {
      await refreshCommunity();
    }
  });
});

  // Buttons
  el("clearMineBtn").addEventListener("click", () => {
    mineHighlights = [];
    saveMine();
    render();
    toast("Cleared all your local highlights.");
  });
  el("refreshCommunityBtn").addEventListener("click", refreshCommunity);
el("clearCommunityBtn").addEventListener("click", () => {
  if (!getApiBase()) { toast("Set API base first."); return; }
  openPwModal();
});

el("pwCancel").addEventListener("click", closePwModal);

el("pwToggle").addEventListener("click", () => {
  const inp = el("pwInput");
  const isPw = inp.type === "password";
  inp.type = isPw ? "text" : "password";

  el("iconEye").style.display = isPw ? "none" : "block";
  el("iconEyeOff").style.display = isPw ? "block" : "none";

  el("pwToggle").setAttribute("aria-label", isPw ? "Hide password" : "Show password");
});

el("pwConfirm").addEventListener("click", async () => {
  const token = el("pwInput").value;
  if (!token) { showPwError("Password required."); return; }

  try {
    await clearCommunityWithPassword(token);
    communityHighlights = [];
    render();
    closePwModal();
    toast("Community highlights cleared.");
  } catch (e) {
    console.warn(e);
    showPwError(String(e.message || e));
  }
});

const content = el("textLayer");
content.addEventListener("mouseup", () => setTimeout(handleSelectionAction, 0));


}

async function main() {
  await loadTools();
  buildPalette();
  loadMine();
  wireUi();
  await loadText();
  if (getApiBase()) refreshCommunity();
}

function hasExactMineHighlight(start, end, colorId) {
  return mineHighlights.some(h =>
    h && h.start === start && h.end === end && h.colorId === colorId
  );
}

function openPwModal() {
  const m = el("pwModal");
  const inp = el("pwInput");
  const err = el("pwError");
  err.style.display = "none";
  err.textContent = "";
  inp.value = "";
  m.classList.add("show");
  m.setAttribute("aria-hidden", "false");
  setTimeout(() => inp.focus(), 0);
}

function closePwModal() {
  const m = el("pwModal");
  m.classList.remove("show");
  m.setAttribute("aria-hidden", "true");
}

function showPwError(msg) {
  const err = el("pwError");
  err.textContent = msg;
  err.style.display = "block";
}

async function clearCommunityWithPassword(token) {
  const apiBase = getApiBase();
  if (!apiBase) throw new Error("Set API base first.");

  const base = apiBase.replace(/\/+$/, "");
  const resp = await fetch(`${base}/admin/clear`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": token
    },
    body: JSON.stringify({ confirm: true })
  });

  // Read body for better diagnostics
  const bodyText = await resp.text();
  if (!resp.ok) {
    // Try to extract JSON error if present
    let msg = bodyText;
    try {
      const j = JSON.parse(bodyText);
      msg = j.error || bodyText;
    } catch {}
    throw new Error(`${resp.status} ${resp.statusText}: ${msg}`);
  }
  return bodyText ? JSON.parse(bodyText) : { ok: true };
}



main();