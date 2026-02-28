/**
 * ConstructAI — App Logic
 * Handles: geolocation, plan generation API calls, canvas rendering,
 *          materials table population, and news feed.
 */

'use strict';

// ── Configuration ──────────────────────────────────────────────────────────────
// Local: calls localhost:8000 | Vercel: same-origin (API served by serverless function)
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:8000'
    : '';  // Vercel serves both frontend and API from same domain

// Room type → canvas fill color mapping
const ROOM_COLORS = {
    default: { fill: '#e8f0fd', stroke: '#1259c3', label: '#0a3d8f' },
    bedroom: { fill: '#e3f2fd', stroke: '#1565c0', label: '#0d47a1' },
    'master bedroom': { fill: '#c8e0fb', stroke: '#0d47a1', label: '#0d47a1' },
    bathroom: { fill: '#e8f5e9', stroke: '#2e7d32', label: '#1b5e20' },
    kitchen: { fill: '#fff3e0', stroke: '#e65100', label: '#bf360c' },
    'living room': { fill: '#f3e5f5', stroke: '#6a1b9a', label: '#4a148c' },
    'dining room': { fill: '#fce4ec', stroke: '#880e4f', label: '#880e4f' },
    garage: { fill: '#f5f5f5', stroke: '#424242', label: '#212121' },
    store: { fill: '#fafafa', stroke: '#616161', label: '#424242' },
    balcony: { fill: '#e0f7fa', stroke: '#006064', label: '#004d40' },
    toilet: { fill: '#e8f5e9', stroke: '#388e3c', label: '#1b5e20' },
    lobby: { fill: '#fff8e1', stroke: '#f57f17', label: '#e65100' },
    corridor: { fill: '#fafafa', stroke: '#9e9e9e', label: '#757575' },
    office: { fill: '#e8eaf6', stroke: '#283593', label: '#1a237e' },
};

// ── Utility Functions ──────────────────────────────────────────────────────────
function getRoomColor(name) {
    const lc = (name || '').toLowerCase();
    for (const key of Object.keys(ROOM_COLORS)) {
        if (key !== 'default' && lc.includes(key)) return ROOM_COLORS[key];
    }
    return ROOM_COLORS.default;
}

function showError(msg) {
    const banner = document.getElementById('errorBanner');
    banner.textContent = '⚠ ' + msg;
    banner.classList.add('visible');
}

function clearError() {
    const banner = document.getElementById('errorBanner');
    banner.textContent = '';
    banner.classList.remove('visible');
}

function showLoading(title = 'Generating your plan…', sub = 'Gemini AI is designing your floor plan') {
    const overlay = document.getElementById('loadingOverlay');
    document.getElementById('loadingTitle').textContent = title;
    document.getElementById('loadingSub').textContent = sub;
    overlay.classList.add('visible');
    overlay.removeAttribute('aria-hidden');
}

function updateLoadingSub(text) {
    const el = document.getElementById('loadingSub');
    if (el) el.textContent = text;
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
}

function setButtonState(disabled) {
    const btn = document.getElementById('generateBtn');
    const detect = document.getElementById('detectBtn');
    btn.disabled = disabled;
    detect.disabled = disabled;
}

// ── Geolocation & Reverse Geocoding ───────────────────────────────────────────
async function detectLocation() {
    const btn = document.getElementById('detectBtn');
    const input = document.getElementById('plotLocation');
    if (!btn || !input) return;

    const original = btn.innerHTML;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin .8s linear infinite"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg><span>Detecting…</span>`;
    btn.disabled = true;
    clearError();
    const resetBtn = () => { btn.innerHTML = original; btn.disabled = false; };

    // ── Race 3 IP geolocation services — fastest non-null wins ────────────────
    async function tryIP(url, parse) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        try {
            const r = await fetch(url, { signal: ctrl.signal });
            if (!r.ok) return null;
            const d = await r.json();
            return parse(d) || null;
        } catch { return null; } finally { clearTimeout(t); }
    }

    const race = Promise.any([
        tryIP('https://ipinfo.io/json',
            d => d.city ? [d.city, d.region, d.country].filter(Boolean).join(', ') : null),
        tryIP('https://ip-api.com/json/?fields=status,city,regionName,country',
            d => d.status === 'success' && d.city ? [d.city, d.regionName, d.country].filter(Boolean).join(', ') : null),
        tryIP('https://ipapi.co/json/',
            d => d.city && !d.error ? [d.city, d.region, d.country_name].filter(Boolean).join(', ') : null),
    ]).catch(() => null);

    // Hard 3s cap so spinner never gets stuck
    const result = await Promise.race([race, new Promise(r => setTimeout(() => r(null), 3000))]);

    resetBtn();
    if (result) {
        input.value = result;
        // Auto-select so user can immediately overtype the correct city
        input.focus();
        input.select();
        // Show hint permanently so user knows to verify
        const hint = document.getElementById('locationHint');
        if (hint) hint.style.display = 'block';
    } else {
        showError('Could not detect location. Please type your city name.');
    }
}

// ── Plan Generation (main orchestrator) ───────────────────────────────────────
let _countdownTimer = null;

function startCountdown(seconds, label = 'Gemini quota resets') {
    clearInterval(_countdownTimer);
    let remaining = seconds;
    updateLoadingSub(`⏳ ${label} in ${remaining}s…`);
    _countdownTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(_countdownTimer);
            updateLoadingSub('Retrying now…');
        } else {
            updateLoadingSub(`⏳ ${label} in ${remaining}s…`);
        }
    }, 1000);
}

function stopCountdown() {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
}

async function fetchWithTimeout(url, options, timeoutMs = 180000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return res;
    } catch (err) {
        clearTimeout(id);
        if (err.name === 'AbortError') {
            throw new Error('Request timed out after 3 minutes. Please try again.');
        }
        throw err;
    }
}

async function generatePlan() {
    clearError();

    const plotArea = document.getElementById('plotArea').value.trim();
    const buildingType = document.getElementById('buildingType').value.trim();
    const location = document.getElementById('plotLocation').value.trim();

    // Validation
    if (!plotArea || isNaN(Number(plotArea)) || Number(plotArea) < 100) {
        showError('Please enter a valid plot area (minimum 100 sq ft).');
        return;
    }
    if (!buildingType) {
        showError('Please describe the building type (e.g. 3-bedroom house).');
        return;
    }
    if (!location) {
        showError('Please enter a plot location or use Detect My Location.');
        return;
    }

    // ── Cache check ─────────────────────────────────────────────────────────────
    const cacheKey = `plan::${plotArea}::${buildingType.toLowerCase()}::${location.toLowerCase()}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
        try {
            const { plan, articles } = JSON.parse(cached);
            showLoading('Loading from cache…', 'Rendering saved results instantly');
            setButtonState(true);
            await new Promise(r => setTimeout(r, 300)); // brief flash so user sees it
            drawFloorPlan(plan.rooms || []);
            populateMaterials(plan.materials || []);
            populateNews(articles || [], location);
            const section = document.getElementById('resultsSection');
            section.classList.add('visible');
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            hideLoading();
            setButtonState(false);
            return; // done — no API call needed
        } catch (_) {
            sessionStorage.removeItem(cacheKey); // corrupt cache — fall through
        }
    }

    setButtonState(true);
    showLoading('Generating your plan…', 'Gemini AI is designing your floor plan & cost estimate');

    const MAX_CLIENT_RETRIES = 2;

    try {
        let plan = null;

        // ── Step 1: Generate floor plan + materials (with client-side retry) ────
        for (let attempt = 0; attempt < MAX_CLIENT_RETRIES; attempt++) {
            let planRes;
            try {
                planRes = await fetchWithTimeout(`${API_BASE}/generate-plan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        plot_area: parseInt(plotArea),
                        building_type: buildingType,
                        location: location,
                    }),
                }, 180000);
            } catch (fetchErr) {
                throw fetchErr; // network / timeout — don't retry
            }

            if (planRes.status === 429) {
                const errData = await planRes.json().catch(() => ({}));
                const retryAfter = errData.retry_after ||
                    parseInt(planRes.headers.get('Retry-After') || '65', 10);

                if (attempt < MAX_CLIENT_RETRIES - 1) {
                    document.getElementById('loadingTitle').textContent = 'Rate limit reached…';
                    startCountdown(retryAfter, 'Gemini quota resets');
                    await new Promise(r => setTimeout(r, retryAfter * 1000));
                    stopCountdown();
                    showLoading('Retrying…', 'Sending request to Gemini AI');
                    continue;
                } else {
                    throw new Error(
                        'Gemini API rate limit exceeded. Please wait ~1 minute and click Generate Plan again.'
                    );
                }
            }

            if (!planRes.ok) {
                const errData = await planRes.json().catch(() => ({}));
                throw new Error(errData.detail || `Server error: ${planRes.status}`);
            }

            plan = await planRes.json();
            break;
        }

        // ── Step 2: Render results ───────────────────────────────────────────────
        showLoading('Rendering floor plan…', 'Drawing your 2D layout');
        window._currentPlan = plan;
        window._currentMeta = { plotArea: parseInt(plotArea), buildingType, location };
        renderFloorPlans(plan.floors || [], { location });
        populateMaterials(plan.materials || []);
        populateVastu(plan.vastu_notes || []);

        // ── Step 3: Fetch news ───────────────────────────────────────────────────
        showLoading('Loading local news…', `Fetching real estate updates for ${location}`);
        await fetchNews(location);

        // ── Step 4: Cache successful result ──────────────────────────────────────
        try {
            const newsGrid = document.getElementById('newsGrid');
            // We'll re-fetch news from cache so store the raw articles
            // Store plan + the fetched articles placeholder (news is cheap to re-fetch)
            sessionStorage.setItem(cacheKey, JSON.stringify({ plan, articles: [] }));
        } catch (_) { /* storage full — skip caching */ }

        // ── Step 5: Show results panel ───────────────────────────────────────────
        const section = document.getElementById('resultsSection');
        section.classList.add('visible');
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
        showError(err.message || 'An unexpected error occurred. Make sure the backend is running.');
    } finally {
        stopCountdown();
        hideLoading();
        setButtonState(false);
    }
}


// ── Architectural Floor Plan Renderer ─────────────────────────────────────────
// Matches professional architectural drawing style: thick walls, door arcs,
// window symbols, furniture silhouettes, dimension labels, title block.

const WALL = 10;   // wall thickness in pixels at final scale

// ──────────────────────────────────────────────────────────────────────────────
// Multi-Floor Tab Renderer
// Creates tab buttons (one per floor) and draws each floor on a separate canvas
// ──────────────────────────────────────────────────────────────────────────────
let _activeFloorIdx = 0;

function renderFloorPlans(floors, meta = {}) {
    if (!floors || floors.length === 0) {
        drawFloorPlan([], meta);
        return;
    }

    // ── Build tab bar ──────────────────────────────────────────────────────────
    let tabBar = document.getElementById('floorTabBar');
    if (!tabBar) {
        tabBar = document.createElement('div');
        tabBar.id = 'floorTabBar';
        tabBar.className = 'floor-tab-bar';
        const canvasContainer = document.querySelector('.canvas-container');
        if (canvasContainer && canvasContainer.parentNode) {
            canvasContainer.parentNode.insertBefore(tabBar, canvasContainer);
        }
    }

    // Hide tab bar if only 1 floor
    tabBar.style.display = floors.length > 1 ? 'flex' : 'none';
    tabBar.innerHTML = '';

    floors.forEach((fl, i) => {
        const btn = document.createElement('button');
        btn.className = 'floor-tab' + (i === _activeFloorIdx ? ' active' : '');
        btn.textContent = fl.name || `Floor ${fl.floor || i + 1}`;
        btn.addEventListener('click', () => {
            _activeFloorIdx = i;
            document.querySelectorAll('.floor-tab').forEach((b, j) => {
                b.classList.toggle('active', j === i);
            });
            drawFloorPlan(fl.rooms || [], meta, fl.name || `Floor ${fl.floor}`);
        });
        tabBar.appendChild(btn);
    });

    // Draw whichever floor is active (reset to 0 when a fresh plan comes in)
    _activeFloorIdx = 0;
    if (tabBar.querySelector('.floor-tab')) {
        tabBar.querySelectorAll('.floor-tab')[0].classList.add('active');
    }
    const activeFloor = floors[_activeFloorIdx];
    drawFloorPlan(activeFloor.rooms || [], meta, activeFloor.name || 'Ground Floor');
}


function drawFloorPlan(rooms, meta = {}, floorName = "Floor Plan") {
    const canvas = document.getElementById('floorPlanCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Make canvas large enough for a crisp drawing
    canvas.width = 1000;
    canvas.height = 700;
    const W = canvas.width, H = canvas.height;

    // ── Background ────────────────────────────────────────────────────────────
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Fine grid (architectural drafting paper feel)
    ctx.strokeStyle = '#e8ecf0';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    if (!rooms || rooms.length === 0) {
        ctx.fillStyle = '#9ca3af';
        ctx.font = '500 16px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No room data available', W / 2, H / 2);
        document.getElementById('canvasLegend').innerHTML = '';
        return;
    }

    // ── Auto-scale ────────────────────────────────────────────────────────────
    const PAD = 80;
    const TITLE_H = 56; // reserve space for title block at bottom
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rooms) {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + (r.width || 1));
        maxY = Math.max(maxY, r.y + (r.length || 1));
    }
    const drawW = W - PAD * 2;
    const drawH = H - PAD * 2 - TITLE_H;
    const scaleX = drawW / (maxX - minX || 1);
    const scaleY = drawH / (maxY - minY || 1);
    const scale = Math.min(scaleX, scaleY) * 0.88;

    const planW = (maxX - minX) * scale;
    const planH = (maxY - minY) * scale;
    const offsetX = (W - planW) / 2 - minX * scale;
    const offsetY = (H - TITLE_H - planH) / 2 - minY * scale;

    const px = (v) => v * scale + offsetX;   // logical x → canvas x
    const py = (v) => v * scale + offsetY;   // logical y → canvas y
    const ps = (v) => v * scale;             // logical size → canvas pixels
    const wt = Math.max(6, scale * 0.8);     // dynamic wall thickness

    // ── 1. Draw room fills (white base; entrance=blue tint, staircase=light grey) ──
    for (const room of rooms) {
        const rx = px(room.x), ry = py(room.y);
        const rw = ps(room.width || 1), rl = ps(room.length || 1);
        const lc = (room.name || '').toLowerCase();
        if (lc.includes('entrance')) ctx.fillStyle = '#e8f0fd'; // Blue tint
        else if (lc.includes('stair')) ctx.fillStyle = '#f4f4f4'; // Slight grey
        else ctx.fillStyle = '#fafafa';
        ctx.fillRect(rx, ry, rw, rl);
    }


    // -- 2. Draw thick walls (shared-wall-aware) --
    const TOUCH = 1.5;
    function hasNeighbour(room, side) {
        for (const other of rooms) {
            if (other === room) continue;
            const rW = room.width || 1, rL = room.length || 1;
            const oW = other.width || 1, oL = other.length || 1;
            const ov = (a, aw, b, bw) => a < b + bw - TOUCH && a + aw > b + TOUCH;
            const eps = TOUCH;
            if (side === 'top' && Math.abs(room.y - (other.y + oL)) < eps && ov(room.x, rW, other.x, oW)) return true;
            if (side === 'bottom' && Math.abs(room.y + rL - other.y) < eps && ov(room.x, rW, other.x, oW)) return true;
            if (side === 'left' && Math.abs(room.x - (other.x + oW)) < eps && ov(room.y, rL, other.y, oL)) return true;
            if (side === 'right' && Math.abs(room.x + rW - other.x) < eps && ov(room.y, rL, other.y, oL)) return true;
        }
        return false;
    }
    ctx.fillStyle = '#2c2c2c';
    for (const room of rooms) {
        const rx = px(room.x), ry = py(room.y);
        const rw = ps(room.width || 1), rl = ps(room.length || 1);
        if (!hasNeighbour(room, 'top')) ctx.fillRect(rx, ry, rw, wt);
        if (!hasNeighbour(room, 'bottom')) ctx.fillRect(rx, ry + rl - wt, rw, wt);
        if (!hasNeighbour(room, 'left')) ctx.fillRect(rx, ry, wt, rl);
        if (!hasNeighbour(room, 'right')) ctx.fillRect(rx + rw - wt, ry, wt, rl);
        ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = Math.max(2, wt * 0.4);
        const dLine = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
        if (hasNeighbour(room, 'top')) dLine(rx, ry + wt / 2, rx + rw, ry + wt / 2);
        if (hasNeighbour(room, 'bottom')) dLine(rx, ry + rl - wt / 2, rx + rw, ry + rl - wt / 2);
        if (hasNeighbour(room, 'left')) dLine(rx + wt / 2, ry, rx + wt / 2, ry + rl);
        if (hasNeighbour(room, 'right')) dLine(rx + rw - wt / 2, ry, rx + rw - wt / 2, ry + rl);
    }

    // -- 3. Door swing arcs (exterior walls only, direction varies) --
    ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = 1.5;
    for (const room of rooms) {
        const rx = px(room.x), ry = py(room.y);
        const rw = ps(room.width || 1), rl = ps(room.length || 1);
        const doorW = Math.min(Math.min(rw, rl) * 0.38, 44);
        const walls = ['bottom', 'right', 'left', 'top'].filter(s => !hasNeighbour(room, s));
        if (!walls.length) continue;
        const wall = walls[0];
        ctx.fillStyle = '#fafafa'; ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = 1.5;
        if (wall === 'bottom') {
            const gx = rx + rw * 0.2, gy = ry + rl - wt;
            ctx.fillRect(gx, gy, doorW, wt + 2);
            ctx.beginPath(); ctx.moveTo(gx, gy + wt / 2); ctx.lineTo(gx + doorW, gy + wt / 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(gx, gy + wt / 2, doorW, 0, Math.PI / 2); ctx.stroke();
        } else if (wall === 'right') {
            const gx = rx + rw - wt, gy = ry + rl * 0.2;
            ctx.fillRect(gx, gy, wt + 2, doorW);
            ctx.beginPath(); ctx.moveTo(gx + wt / 2, gy); ctx.lineTo(gx + wt / 2, gy + doorW); ctx.stroke();
            ctx.beginPath(); ctx.arc(gx + wt / 2, gy, doorW, Math.PI / 2, Math.PI); ctx.stroke();
        } else if (wall === 'left') {
            const gx = rx, gy = ry + rl * 0.2;
            ctx.fillRect(gx - 1, gy, wt + 2, doorW);
            ctx.beginPath(); ctx.moveTo(gx + wt / 2, gy); ctx.lineTo(gx + wt / 2, gy + doorW); ctx.stroke();
            ctx.beginPath(); ctx.arc(gx + wt / 2, gy + doorW, doorW, -Math.PI / 2, 0); ctx.stroke();
        } else {
            const gx = rx + rw * 0.2, gy = ry;
            ctx.fillRect(gx, gy - 1, doorW, wt + 2);
            ctx.beginPath(); ctx.moveTo(gx, gy + wt / 2); ctx.lineTo(gx + doorW, gy + wt / 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(gx + doorW, gy + wt / 2, doorW, Math.PI, Math.PI * 1.5); ctx.stroke();
        }
    }

    // -- 4. Window symbols (exterior walls only) --
    ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = 1;
    for (const room of rooms) {
        const lc = (room.name || '').toLowerCase();
        if (lc.includes('corridor') || lc.includes('lobby') || lc.includes('garage') ||
            lc.includes('pooja') || lc.includes('bathroom') || lc.includes('toilet') ||
            lc.includes('wc') || lc.includes('entrance')) continue;
        const rx = px(room.x), ry = py(room.y);
        const rw = ps(room.width || 1), rl = ps(room.length || 1);
        const drawWin = (wx, wy, ww, horiz) => {
            ctx.fillStyle = '#fafafa';
            if (horiz) ctx.fillRect(wx, wy - 1, ww, wt + 2); else ctx.fillRect(wx - 1, wy, wt + 2, ww);
            ctx.fillStyle = '#2c2c2c';
            for (let i = 0; i < 3; i++) {
                const off = (wt / 4) + (i * wt / 3.5);
                ctx.beginPath();
                if (horiz) { ctx.moveTo(wx, wy + off); ctx.lineTo(wx + ww, wy + off); }
                else { ctx.moveTo(wx + off, wy); ctx.lineTo(wx + off, wy + ww); }
                ctx.stroke();
            }
        };
        const winW = Math.min(rw * 0.42, 52), winH = Math.min(rl * 0.42, 52);
        if (!hasNeighbour(room, 'top')) drawWin(rx + (rw - winW) / 2, ry, winW, true);
        else if (!hasNeighbour(room, 'right')) drawWin(rx + rw - wt, ry + (rl - winH) / 2, winH, false);
    }

    // -- 5. Furniture silhouettes --

    // ── 5. Furniture silhouettes ───────────────────────────────────────────────
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    for (const room of rooms) {
        const rx = px(room.x), ry = py(room.y);
        const rw = ps(room.width || 1), rl = ps(room.length || 1);
        const lc = (room.name || '').toLowerCase();
        drawFurniture(ctx, lc, rx + wt, ry + wt, rw - wt * 2, rl - wt * 2);
    }

    // ── 6. Room labels + area ─────────────────────────────────────────────────
    for (const room of rooms) {
        const rx = px(room.x), ry = py(room.y);
        const rw = ps(room.width || 1), rl = ps(room.length || 1);
        const cx = rx + rw / 2, cy = ry + rl / 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(rx + wt + 2, ry + wt + 2, rw - wt * 2 - 4, rl - wt * 2 - 4);
        ctx.clip();

        const fs = Math.max(9, Math.min(13, rw / 8));
        ctx.fillStyle = '#1a1a1a';
        ctx.font = `600 ${fs}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(room.name, cx, cy - fs * 0.7, rw - wt * 2 - 6);

        // Area in m²
        const sqm = ((room.width || 1) * (room.length || 1) * 0.093).toFixed(1);
        ctx.fillStyle = '#555';
        ctx.font = `400 ${Math.max(8, fs - 2)}px Inter, sans-serif`;
        ctx.fillText(`${sqm} m²`, cx, cy + fs * 0.7, rw - wt * 2 - 6);
        ctx.restore();
    }

    // ── 7. North arrow (top-right) ────────────────────────────────────────────
    {
        const nx = W - 52, ny = 48, nr = 20;
        ctx.save();
        ctx.strokeStyle = '#1a1a1a'; ctx.fillStyle = '#1a1a1a'; ctx.lineWidth = 1.5;
        // Arrow shaft
        ctx.beginPath(); ctx.moveTo(nx, ny - nr); ctx.lineTo(nx, ny + nr); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(nx - nr * 0.6, ny + nr * 0.3); ctx.lineTo(nx, ny - nr); ctx.lineTo(nx + nr * 0.6, ny + nr * 0.3); ctx.closePath(); ctx.fill();
        // N label
        ctx.font = 'bold 13px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('N', nx, ny + nr + 12);
        ctx.restore();
    }

    // ── 8. Title block (bottom) ────────────────────────────────────────────────
    {
        const ty = H - TITLE_H;
        ctx.fillStyle = '#f0f2f5';
        ctx.fillRect(0, ty, W, TITLE_H);
        ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(W, ty); ctx.stroke();

        ctx.fillStyle = '#1a1a1a';
        ctx.font = 'bold 18px Inter, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(floorName.toUpperCase(), 20, ty + TITLE_H / 2);

        ctx.font = '500 12px Inter, sans-serif';
        ctx.fillStyle = '#555';
        const dateStr = new Date().toLocaleDateString('en-IN');
        ctx.fillText(`ConstructAI  ·  Generated ${dateStr}  ·  Vastu Compliant`, 160, ty + TITLE_H / 2 - 6);

        if (meta.location) {
            ctx.font = '400 11px Inter, sans-serif';
            ctx.fillText(`Location: ${meta.location}`, 160, ty + TITLE_H / 2 + 10);
        }

        ctx.textAlign = 'right';
        ctx.fillStyle = '#1a1a1a';
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.fillText('Scale: NTS  ·  Powered by Groq AI', W - 20, ty + TITLE_H / 2);
    }

    // ── 9. Clear DOM legend (now embedded in drawing) ─────────────────────────
    const legendEl = document.getElementById('canvasLegend');
    if (legendEl) legendEl.innerHTML = '';
}

// ── Furniture Silhouette Renderer ──────────────────────────────────────────────
function drawFurniture(ctx, roomType, rx, ry, rw, rl) {
    if (rw < 30 || rl < 30) return;
    ctx.save();
    ctx.strokeStyle = '#888';
    ctx.fillStyle = '#e8e8e8';
    ctx.lineWidth = 1;

    if (roomType.includes('master bedroom') || (roomType.includes('bedroom') && roomType.includes('master'))) {
        // Double bed (centered)
        const bw = Math.min(rw * 0.6, 80), bl = Math.min(rl * 0.55, 70);
        const bx = rx + (rw - bw) / 2, by = ry + (rl - bl) / 2;
        ctx.fillRect(bx, by, bw, bl); ctx.strokeRect(bx, by, bw, bl);
        // Pillows
        ctx.fillStyle = '#fff'; ctx.fillRect(bx + 5, by + 5, bw / 2 - 8, bl * 0.25); ctx.strokeRect(bx + 5, by + 5, bw / 2 - 8, bl * 0.25);
        ctx.fillRect(bx + bw / 2 + 3, by + 5, bw / 2 - 8, bl * 0.25); ctx.strokeRect(bx + bw / 2 + 3, by + 5, bw / 2 - 8, bl * 0.25);

    } else if (roomType.includes('bedroom')) {
        // Single bed
        const bw = Math.min(rw * 0.55, 60), bl = Math.min(rl * 0.55, 75);
        const bx = rx + (rw - bw) / 2, by = ry + (rl - bl) / 2;
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(bx, by, bw, bl); ctx.strokeRect(bx, by, bw, bl);
        ctx.fillStyle = '#fff'; ctx.fillRect(bx + 4, by + 4, bw - 8, bl * 0.25); ctx.strokeRect(bx + 4, by + 4, bw - 8, bl * 0.25);

    } else if (roomType.includes('living')) {
        // Sofa L-shape
        const sw = Math.min(rw * 0.7, 90), sh = 18;
        const sx = rx + (rw - sw) / 2, sy = ry + rl * 0.55;
        ctx.fillStyle = '#e0e0e0';
        ctx.fillRect(sx, sy, sw, sh); ctx.strokeRect(sx, sy, sw, sh);            // main sofa
        ctx.fillRect(sx, sy - sh * 1.8, sh, sh * 1.8); ctx.strokeRect(sx, sy - sh * 1.8, sh, sh * 1.8); // side arm
        // Coffee table
        const tw = sw * 0.45, th = sh * 1.2;
        ctx.fillStyle = '#d8d8d8';
        ctx.fillRect(sx + sw * 0.25, sy - sh * 2.4, tw, th); ctx.strokeRect(sx + sw * 0.25, sy - sh * 2.4, tw, th);

    } else if (roomType.includes('kitchen')) {
        // Counter L-shape along two walls
        const cw = 18;
        ctx.fillStyle = '#e0e0e0';
        ctx.fillRect(rx, ry, rw, cw); ctx.strokeRect(rx, ry, rw, cw);    // top counter
        ctx.fillRect(rx + rw - cw, ry, cw, rl); ctx.strokeRect(rx + rw - cw, ry, cw, rl); // right counter
        // Stove circles
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
                const cx = rx + rw - cw / 2;
                const cy = ry + rl * 0.3 + i * rl * 0.2;
                ctx.beginPath(); ctx.arc(cx, cy + j * 16 - 8, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#aaa'; ctx.fill(); ctx.stroke();
            }
        }

    } else if (roomType.includes('bathroom') || roomType.includes('bath') || roomType.includes('wc') || roomType.includes('toilet')) {
        // Toilet
        const tr = Math.min(rw * 0.35, 22);
        const tx = rx + rw / 2, ty_c = ry + rl * 0.7;
        ctx.fillStyle = '#e8e8e8';
        ctx.beginPath(); ctx.ellipse(tx, ty_c, tr * 0.7, tr, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillRect(tx - tr * 0.7, ty_c - tr - 10, tr * 1.4, 12); ctx.strokeRect(tx - tr * 0.7, ty_c - tr - 10, tr * 1.4, 12);
        // Sink
        const sr = Math.min(rw * 0.28, 18);
        ctx.beginPath(); ctx.arc(rx + rw / 2, ry + rl * 0.25, sr, 0, Math.PI * 2);
        ctx.fillStyle = '#eee'; ctx.fill(); ctx.stroke();

    } else if (roomType.includes('dining')) {
        // Round table + chairs
        const tr = Math.min(rw * 0.3, 35);
        const tcx = rx + rw / 2, tcy = ry + rl / 2;
        ctx.beginPath(); ctx.arc(tcx, tcy, tr, 0, Math.PI * 2);
        ctx.fillStyle = '#e0e0e0'; ctx.fill(); ctx.stroke();
        // 4 chairs (small rects around table)
        const angles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
        const cr = tr + 10, cw2 = 14, ch2 = 10;
        ctx.fillStyle = '#ccc';
        for (const a of angles) {
            const ccx = tcx + Math.cos(a) * cr, ccy = tcy + Math.sin(a) * cr;
            ctx.save(); ctx.translate(ccx, ccy); ctx.rotate(a);
            ctx.fillRect(-cw2 / 2, -ch2 / 2, cw2, ch2); ctx.strokeRect(-cw2 / 2, -ch2 / 2, cw2, ch2);
            ctx.restore();
        }

    } else if (roomType.includes('garage')) {
        // Car outline (simplified)
        const cw2 = Math.min(rw * 0.7, 80), cl = Math.min(rl * 0.6, 50);
        const cx2 = rx + (rw - cw2) / 2, cy2 = ry + (rl - cl) / 2;
        ctx.fillStyle = '#ddd';
        ctx.fillRect(cx2, cy2, cw2, cl); ctx.strokeRect(cx2, cy2, cw2, cl);
        // Wheels
        const wr = 7;
        [[cx2 + wr, cy2 + wr], [cx2 + cw2 - wr, cy2 + wr], [cx2 + wr, cy2 + cl - wr], [cx2 + cw2 - wr, cy2 + cl - wr]].forEach(([wx, wy]) => {
            ctx.beginPath(); ctx.arc(wx, wy, wr - 1, 0, Math.PI * 2);
            ctx.fillStyle = '#aaa'; ctx.fill(); ctx.stroke();
        });

    } else if (roomType.includes('stair')) {
        // ── Architectural stair symbol ─────────────────────────────────────────
        // Draw a series of parallel horizontal lines (treads) with a directional arrow
        const steps = Math.max(5, Math.min(10, Math.floor(rl / 14)));
        const stepH = rl / steps;
        ctx.strokeStyle = '#444'; ctx.lineWidth = 1.2;
        for (let i = 0; i <= steps; i++) {
            const ly = ry + i * stepH;
            ctx.beginPath(); ctx.moveTo(rx, ly); ctx.lineTo(rx + rw, ly); ctx.stroke();
        }
        // Vertical mid-line (handrail)
        const midX = rx + rw / 2;
        ctx.beginPath(); ctx.moveTo(midX, ry); ctx.lineTo(midX, ry + rl); ctx.stroke();
        // Arrow going UP (indicating direction of ascent)
        ctx.strokeStyle = '#222'; ctx.fillStyle = '#222'; ctx.lineWidth = 2;
        const arrowX = rx + rw * 0.75;
        const arrowY1 = ry + rl * 0.7, arrowY2 = ry + rl * 0.15;
        ctx.beginPath(); ctx.moveTo(arrowX, arrowY1); ctx.lineTo(arrowX, arrowY2); ctx.stroke();
        const aw = 6;
        ctx.beginPath();
        ctx.moveTo(arrowX - aw, arrowY2 + aw * 1.5);
        ctx.lineTo(arrowX, arrowY2);
        ctx.lineTo(arrowX + aw, arrowY2 + aw * 1.5);
        ctx.stroke();
        // "UP" label
        ctx.fillStyle = '#333'; ctx.font = 'bold 9px Inter, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('UP', arrowX, arrowY2 - 10);

    } else if (roomType.includes('main entrance') || roomType.includes('entrance')) {
        // ── Main Entrance — prominent double-door + arrow ──────────────────────
        // Blue filled background to make it stand out
        ctx.fillStyle = 'rgba(18,89,195,0.08)';
        ctx.fillRect(rx, ry, rw, rl);
        // Double door arcs
        const dw = Math.min(rw * 0.4, 28);
        const dy = ry + rl * 0.2;
        ctx.strokeStyle = '#1259c3'; ctx.fillStyle = 'rgba(18,89,195,0.2)'; ctx.lineWidth = 1.5;
        // Left door leaf
        ctx.beginPath(); ctx.moveTo(rx + rw * 0.3, dy); ctx.lineTo(rx + rw * 0.3 - dw, dy); ctx.stroke();
        ctx.beginPath(); ctx.arc(rx + rw * 0.3, dy, dw, Math.PI, Math.PI * 1.5); ctx.stroke();
        // Right door leaf
        ctx.beginPath(); ctx.moveTo(rx + rw * 0.7, dy); ctx.lineTo(rx + rw * 0.7 + dw, dy); ctx.stroke();
        ctx.beginPath(); ctx.arc(rx + rw * 0.7, dy, dw, -Math.PI * 0.5, 0); ctx.stroke();
        // Bold "MAIN ENTRANCE" label
        ctx.fillStyle = '#1259c3'; ctx.font = 'bold 9px Inter, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('MAIN ENTRANCE', rx + rw / 2, ry + rl * 0.7);
        // Arrow pointing outward (down = exterior direction)
        ctx.strokeStyle = '#1259c3'; ctx.lineWidth = 1.5;
        const ex = rx + rw / 2, ey1 = ry + rl * 0.8, ey2 = ry + rl - 5;
        ctx.beginPath(); ctx.moveTo(ex, ey1); ctx.lineTo(ex, ey2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ex - 5, ey2 - 6); ctx.lineTo(ex, ey2); ctx.lineTo(ex + 5, ey2 - 6); ctx.stroke();
    }
    ctx.restore();
}


// ── Materials Table Population ─────────────────────────────────────────────────
function populateMaterials(materials) {
    const tbody = document.getElementById('materialsBody');
    const tfoot = document.getElementById('materialsFoot');
    tbody.innerHTML = '';
    tfoot.innerHTML = '';

    if (!materials || materials.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:24px">No materials data returned.</td></tr>`;
        return;
    }

    materials.forEach((m, i) => {
        const tr = document.createElement('tr');
        tr.style.animationDelay = `${i * 0.04}s`;
        tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(m.item || '')}</td>
      <td>${escapeHtml(m.quantity || '')}</td>
      <td>${escapeHtml(m.estimated_cost || '')}</td>
    `;
        tbody.appendChild(tr);
    });

    // Total row — robustly parse and sum all costs
    const totalRow = document.createElement('tr');
    totalRow.innerHTML = `
    <td colspan="3" style="text-align:right;font-weight:700;font-size:.9rem;color:#5c6780;">
      Estimated Total (approx.)
    </td>
    <td id="totalCostCell">—</td>
  `;
    tfoot.appendChild(totalRow);

    /**
     * parseCost(str) → number (absolute rupees)
     * Handles:
     *   "₹20 lakhs"   → 2000000
     *   "₹20 lakh"    → 2000000
     *   "₹20L"        → 2000000
     *   "₹3,50,000"   → 350000
     *   "₹350000"     → 350000
     *   "3.5 lakhs"   → 350000
     */
    function parseCost(str) {
        if (!str) return 0;
        const s = String(str).replace(/,/g, '').trim();
        // Check for lakh/L suffix
        const lakhMatch = s.match(/([₹$£€]?)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:lakh|lakhs|L)\b/i);
        if (lakhMatch) return parseFloat(lakhMatch[2]) * 100000;
        // Plain absolute number with optional currency symbol
        const absMatch = s.match(/[₹$£€]?\s*([0-9]+(?:\.[0-9]+)?)/);
        if (absMatch) return parseFloat(absMatch[1]);
        return 0;
    }

    let sum = 0;
    for (const m of materials) {
        sum += parseCost(m.estimated_cost);
    }

    const totalCell = document.getElementById('totalCostCell');
    if (sum > 0) {
        // Format as Indian notation (₹XX,XX,XXX)
        const formatted = '₹' + Math.round(sum).toLocaleString('en-IN');
        // Also show in lakhs for readability
        const inLakhs = (sum / 100000).toFixed(1);
        totalCell.innerHTML = `<strong>${formatted}</strong><br><small style="color:#5c6780;font-weight:400">(~₹${inLakhs} lakhs)</small>`;
    }
}

// ── News Fetcher ───────────────────────────────────────────────────────────────
async function fetchNews(location) {
    try {
        const res = await fetch(`${API_BASE}/get-news?location=${encodeURIComponent(location)}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'News API error');
        }
        const data = await res.json();
        populateNews(data.articles || [], location);
    } catch (e) {
        populateNews([], location, e.message);
    }
}

function populateNews(articles, location, errorMsg) {
    const grid = document.getElementById('newsGrid');
    const subtitle = document.getElementById('newsSubtitle');
    grid.innerHTML = '';

    if (location) {
        subtitle.textContent = `Real estate & infrastructure updates for ${location}`;
    }

    if (errorMsg) {
        grid.innerHTML = `<div class="news-empty"><p>⚠ Could not load news: ${escapeHtml(errorMsg)}</p></div>`;
        return;
    }

    if (!articles || articles.length === 0) {
        grid.innerHTML = `<div class="news-empty"><p>No news articles found for this location.</p></div>`;
        return;
    }

    articles.forEach((a, i) => {
        const date = a.published_at ? formatDate(a.published_at) : '';
        const imgHtml = a.image
            ? `<img src="${escapeHtml(a.image)}" alt="${escapeHtml(a.title)}" loading="lazy" onerror="this.parentElement.innerHTML=placeholderSvg()">`
            : `<div class="news-img-placeholder">${placeholderSvg()}</div>`;

        const card = document.createElement('div');
        card.className = 'news-article-card';
        card.style.animationDelay = `${i * 0.08}s`;
        card.innerHTML = `
      <div class="news-img-wrapper">${imgHtml}</div>
      <div class="news-content">
        <div class="news-source-row">
          <span class="news-source">${escapeHtml(a.source || 'News')}</span>
          <span class="news-date">${date}</span>
        </div>
        <div class="news-title">${escapeHtml(a.title || '')}</div>
        <div class="news-desc">${escapeHtml(a.description || '')}</div>
        <a class="news-link" href="${escapeHtml(a.url || '#')}" target="_blank" rel="noopener noreferrer">
          Read full article
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </a>
      </div>
    `;
        grid.appendChild(card);
    });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function placeholderSvg() {
    return `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
}

function formatDate(iso) {
    try {
        return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return ''; }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
}

// ── Canvas Download ────────────────────────────────────────────────────────────
function downloadCanvas() {
    const canvas = document.getElementById('floorPlanCanvas');
    const link = document.createElement('a');
    link.download = 'floor-plan.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
}

// ── Reset ──────────────────────────────────────────────────────────────────────
function resetAll() {
    document.getElementById('plotArea').value = '';
    document.getElementById('buildingType').value = '';
    document.getElementById('plotLocation').value = '';
    document.getElementById('resultsSection').classList.remove('visible');
    document.getElementById('materialsBody').innerHTML = '';
    document.getElementById('materialsFoot').innerHTML = '';
    document.getElementById('newsGrid').innerHTML = '';
    document.getElementById('canvasLegend').innerHTML = '';
    const vastuEl = document.getElementById('vastuNotes');
    if (vastuEl) vastuEl.innerHTML = '';
    const chatHistory = document.getElementById('chatHistory');
    if (chatHistory) chatHistory.innerHTML = '';
    window._currentPlan = null;
    window._currentMeta = null;
    clearError();
    const canvas = document.getElementById('floorPlanCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ── Vastu Notes Renderer ───────────────────────────────────────────────────────
function populateVastu(notes) {
    const el = document.getElementById('vastuNotes');
    if (!el) return;
    if (!notes || notes.length === 0) { el.innerHTML = ''; return; }
    el.innerHTML = notes.map(n => `
        <div class="vastu-badge ${n.compliant ? 'vastu-ok' : 'vastu-warn'}">
            <span class="vastu-icon">${n.compliant ? '✅' : '⚠️'}</span>
            <span class="vastu-room">${escapeHtml(n.room)}</span>
            <span class="vastu-dir">${escapeHtml(n.direction)}</span>
            <span class="vastu-note">${escapeHtml(n.note || '')}</span>
        </div>
    `).join('');
}

// ── AI Chat — Modification System ─────────────────────────────────────────────
function addChatBubble(text, role = 'user') {
    const history = document.getElementById('chatHistory');
    if (!history) return;
    const div = document.createElement('div');
    div.className = `chat-bubble chat-${role}`;
    div.innerHTML = escapeHtml(text);
    history.appendChild(div);
    history.scrollTop = history.scrollHeight;
}

function addChatLoadingBubble() {
    const history = document.getElementById('chatHistory');
    if (!history) return null;
    const div = document.createElement('div');
    div.className = 'chat-bubble chat-ai chat-loading';
    div.innerHTML = '<span class="chat-dots"><span></span><span></span><span></span></span>';
    history.appendChild(div);
    history.scrollTop = history.scrollHeight;
    return div;
}

async function submitModification() {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('chatSubmitBtn');
    const text = (input?.value || '').trim();
    if (!text) return;
    if (!window._currentPlan || !window._currentMeta) {
        addChatBubble('⚠ Please generate a plan first before making modifications.', 'ai');
        return;
    }

    addChatBubble(text, 'user');
    input.value = '';
    btn.disabled = true;

    const loadingBubble = addChatLoadingBubble();

    try {
        const res = await fetchWithTimeout(`${API_BASE}/modify-plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                current_plan: window._currentPlan,
                modification_request: text,
                plot_area: window._currentMeta.plotArea,
                building_type: window._currentMeta.buildingType,
                location: window._currentMeta.location,
            }),
        }, 60000);

        if (loadingBubble) loadingBubble.remove();

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            addChatBubble(`❌ Error: ${err.detail || res.status}`, 'ai');
            return;
        }

        const updatedPlan = await res.json();
        window._currentPlan = updatedPlan;

        // Re-render with updated plan
        renderFloorPlans(updatedPlan.floors || [], { location: window._currentMeta.location });
        populateMaterials(updatedPlan.materials || []);
        populateVastu(updatedPlan.vastu_notes || []);

        addChatBubble('✅ Plan updated! The floor plan and materials have been revised.', 'ai');

    } catch (err) {
        if (loadingBubble) loadingBubble.remove();
        addChatBubble(`❌ ${err.message || 'Failed to apply modification.'}`, 'ai');
    } finally {
        btn.disabled = false;
    }
}

// ── Allow Enter key to submit ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const inputs = ['plotArea', 'buildingType', 'plotLocation'];
    inputs.forEach(id => {
        document.getElementById(id).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') generatePlan();
        });
    });

    // Chat input
    const chatInput = document.getElementById('chatInput');
    const chatBtn = document.getElementById('chatSubmitBtn');
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitModification(); }
        });
    }
    if (chatBtn) chatBtn.addEventListener('click', submitModification);
});
