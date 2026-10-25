import {
    ALL_ERAS, CLASSES, Optimizer, PRESETS, STATS, classList, classPreset, parseInventory,
    restrictionLabel, typesFromMask,
} from './core.js';

const SETTINGS_KEY = 'bisaug.settings';
const INVENTORY_KEY = 'bisaug.inventory';
const CUSTOM_PRESET = 'Custom';
const ALTERNATIVES = 5;

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let optimizer;
let settings;
let inventory = null;
let inventoryName = '';
let result = null;
const expanded = new Set();

function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode or storage full */ }
}

function defaultSettings() {
    const preset = classPreset('SHD');
    return {
        classCode: 'SHD', level: 85, eraCap: 85, andOlder: true, myClassOnly: true, includeEvents: false,
        preset: preset.name, weights: { ...preset.weights }, shieldAc: preset.shieldAc,
    };
}

function loadSettings() {
    const saved = JSON.parse(storageGet(SETTINGS_KEY) || 'null');
    return { ...defaultSettings(), ...(saved || {}) };
}

function saveSettings() {
    storageSet(SETTINGS_KEY, JSON.stringify(settings));
}

function runSettings() {
    return { ...settings, classIndex: CLASSES.findIndex(([code]) => code === settings.classCode) };
}

// ---------- shared rendering ----------

function augLink(aug, label) {
    const text = escapeHtml(label ?? aug.n);
    if (!optimizer.byId.has(aug.id)) return `<span>${text}</span>`;
    // Allakhazam item pages use their own ids, not EQ's, so link to a name search
    const url = `https://everquest.allakhazam.com/search.html?q=${encodeURIComponent(aug.n)}`;
    return `<a class="aug" data-id="${aug.id}" href="${url}" target="_blank" rel="noopener">${text}</a>`;
}

function gainHtml(gain, unit = '') {
    const text = `${gain > 0 ? '+' : ''}${gain}${unit}`;
    const css = gain > 0 ? 'good' : gain < 0 ? 'bad' : 'muted';
    return `<span class="${css}">${text}</span>`;
}

function eraText(aug) {
    if (aug.ev) return aug.ev;
    const { code, era } = optimizer.effective(aug);
    if (!code) return optimizer.eraLabel(era);
    return optimizer.expansionByCode.get(code)?.ev ? optimizer.expansionByCode.get(code).n : `${era} (${code})`;
}

const ownedText = (owned) => [...new Set(owned.map((entry) => entry.where))].join(', ');
const unitFor = (socket) => (socket.profile === 'weapon' ? ' dmg' : '');

// ---------- optimizer tab ----------

function optimizerTab() {
    if (!result) return '<p class="muted">Load your inventory file to see your aug sockets.</p>';
    let now = 0;
    let best = 0;
    let damage = 0;
    for (const socket of result.sockets) {
        const current = socket.current?.score || 0;
        const chosen = socket.choice?.score || 0;
        if (socket.profile === 'weapon') damage += chosen - current;
        else { now += current; best += chosen; }
    }
    const rows = result.sockets.map((socket, index) => {
        const choice = socket.choice;
        let optimized = '<span class="muted">-</span>';
        if (choice?.isCurrent) optimized = '<span class="muted">Keep current</span>';
        else if (choice) {
            const note = choice.movedFrom ? `move from ${choice.movedFrom}` : choice.owned ? `in ${ownedText(choice.owned).toLowerCase()}` : '';
            optimized = augLink(choice.aug) + (note ? ` <span class="muted">(${escapeHtml(note)})</span>` : '');
        }
        const gain = choice ? gainHtml(choice.score - (socket.current?.score || 0), unitFor(socket)) : '';
        return socketRow(String(index), socket, socket.current ? augLink(socket.current.aug) : '<span class="warn">Empty</span>', optimized, gain);
    }).join('');
    return `<p class="summary">Score ${now} now, ${best} optimized (${gainHtml(best - now)}). Weapon damage ${gainHtml(damage)}.
        <span class="muted">Lore augs are used once. Expand a slot for more options.</span></p>
        <table><thead><tr><th>Slot</th><th>Current</th><th>Optimized</th><th class="num">Gain</th></tr></thead>
        <tbody>${rows}${twoHandRow(result.twoHand)}</tbody></table>`;
}

function socketRow(key, socket, current, optimized, gain) {
    const open = expanded.has(key);
    const html = `<tr>
        <td><button type="button" class="toggle" data-socket="${key}">${open ? '&#9662;' : '&#9656;'}</button>
            <span title="${escapeHtml(socket.itemName)}">${escapeHtml(socket.slotName)}</span> <span class="muted">type ${socket.augType}</span></td>
        <td>${current}</td><td>${optimized}</td><td class="num">${gain}</td></tr>`;
    return open ? html + alternativesHtml(socket) : html;
}

// What-if row: the best aug if you swapped to a two-handed weapon.
function twoHandRow(socket) {
    const choice = socket.choice;
    const optimized = choice
        ? augLink(choice.aug) + (choice.owned ? ` <span class="muted">(in ${escapeHtml(ownedText(choice.owned).toLowerCase())})</span>` : '')
        : '<span class="muted">-</span>';
    return socketRow('twoHand', socket, '<span class="muted">what-if: any two-handed weapon</span>', optimized,
        choice ? gainHtml(choice.score, ' dmg') : '');
}

function alternativesHtml(socket) {
    const others = socket.options.filter((option) => option !== socket.choice).slice(0, ALTERNATIVES);
    if (!others.length) return '<tr class="alt"><td></td><td colspan="3" class="muted">No other options under these filters.</td></tr>';
    return others.map((option, index) => {
        const usedIn = option.aug.k && socket.usedBy.get(option.aug.k);
        const gain = usedIn ? `<span class="muted">lore, used in ${escapeHtml(usedIn)}</span>`
            : gainHtml(option.score - (socket.whatIf ? 0 : socket.current?.score || 0), unitFor(socket));
        return `<tr class="alt"><td class="muted">#${index + 2}</td><td></td><td>${augLink(option.aug)}</td><td class="num">${gain}</td></tr>`;
    }).join('');
}

// ---------- to farm tab ----------

function farmEntries(owned) {
    const entries = new Map();
    for (const socket of result.sockets) {
        const choice = socket.choice;
        if (!choice || choice.isCurrent || choice.movedFrom || Boolean(choice.owned) !== owned) continue;
        const unit = unitFor(socket);
        const key = `${choice.aug.id}${unit}`;
        const entry = entries.get(key) || { aug: choice.aug, owned: choice.owned, slots: [], gain: 0, unit };
        entry.slots.push(socket.slotName);
        entry.gain += choice.score - (socket.current?.score || 0);
        entries.set(key, entry);
    }
    return [...entries.values()].sort((a, b) => b.gain - a.gain);
}

function farmTable(entries, owned) {
    if (!entries.length) return '<p class="muted">Nothing here.</p>';
    const rows = entries.map((entry) => `<tr><td>${augLink(entry.aug)}</td><td>${escapeHtml(entry.slots.join(', '))}</td>
        <td class="num">${gainHtml(entry.gain, entry.unit)}</td><td>${escapeHtml(owned ? ownedText(entry.owned) : eraText(entry.aug))}</td></tr>`).join('');
    return `<table><thead><tr><th>Aug</th><th>For</th><th class="num">Gain</th><th>${owned ? 'Where' : 'Era'}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function farmTab() {
    if (!result) return '<p class="muted">Load your inventory file first.</p>';
    return `<h3 class="good">Already own - equip these</h3>${farmTable(farmEntries(true), true)}
        <h3>To farm</h3><p class="muted">Click an aug to see where it drops.</p>${farmTable(farmEntries(false), false)}`;
}

// ---------- type 3 tab ----------

function spellsTab() {
    if (!result) return '<p class="muted">Load your inventory file first.</p>';
    const sockets = result.spellSockets.map((socket) => `<li>${escapeHtml(socket.slotName)}: ${socket.currentId
        ? augLink(optimizer.byId.get(socket.currentId) || { id: socket.currentId, n: socket.currentName })
        : '<span class="warn">Empty</span>'}</li>`).join('');
    const lines = optimizer.spellAugs(inventory, runSettings());
    const statusClass = { Worn: 'good', Owned: 'warn', Missing: 'muted' };
    const rows = lines.flatMap((line) => line.augs.map((entry, index) => `<tr>
        <td class="num">${index === 0 ? line.level : ''}</td>
        <td>${index === 0 ? escapeHtml(line.spell) : ''}</td>
        <td>${index === 0 ? escapeHtml(line.expansion || '') : ''}</td>
        <td>${augLink(entry.aug)}</td>
        <td class="${statusClass[entry.status]}">${entry.status}${entry.owned ? ` <span class="muted">(${escapeHtml(ownedText(entry.owned))})</span>` : ''}</td></tr>`)).join('');
    return `<h3>Your type 3 sockets</h3><ul>${sockets || '<li class="muted">None found.</li>'}</ul>
        <h3>Spell augs for ${escapeHtml(CLASSES.find(([code]) => code === settings.classCode)[1])} at level ${settings.level}</h3>
        <p class="muted">The highest spell you can have in each spell line at this level and era, and the augs that boost it.</p>
        <table><thead><tr><th class="num">Level</th><th>Spell</th><th>Expansion</th><th>Aug</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- search tab ----------

function runSearch() {
    const mask = $('searchTypes').value.split(/[^0-9]+/).map(Number).filter((type) => type >= 1 && type <= 30)
        .reduce((total, type) => total | (1 << (type - 1)), 0);
    const rows = mask ? optimizer.rank(mask, runSettings(), Number($('searchLevel').value) || 0, null, 100) : [];
    const weighted = STATS.filter(([key]) => settings.weights[key]);
    $('searchCount').textContent = `${rows.length} results`;
    $('searchResults').innerHTML = `<table><thead><tr><th>Name</th><th>Era</th><th>Types</th><th>Gear</th><th class="num">Score</th>
        ${weighted.map(([, label]) => `<th class="num">${label}</th>`).join('')}</tr></thead><tbody>${rows.map(({ aug, score }) => `<tr>
        <td>${augLink(aug)}</td><td>${escapeHtml(eraText(aug))}</td><td>${typesFromMask(aug.t).join(' ')}</td>
        <td>${restrictionLabel(aug.r)}</td><td class="num">${score}</td>
        ${weighted.map(([key]) => `<td class="num">${aug.s?.[key] || 0}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ---------- tooltip ----------

function tooltipHtml(aug) {
    const stats = STATS.filter(([key]) => aug.s?.[key]).map(([key, label]) => `${label} ${aug.s[key]}`);
    if (aug.s?.dmg) stats.push(`Weapon Dmg ${aug.s.dmg}`);
    return `<div class="name">${escapeHtml(aug.n)}</div>
        <div>Slot types: ${typesFromMask(aug.t).join(' ')} &nbsp; Gear: ${restrictionLabel(aug.r)}${aug.k ? ' &nbsp; LORE' : ''}</div>
        ${stats.length ? `<div>${stats.join(' &nbsp; ')}</div>` : ''}
        ${aug.sp ? `<div>Boosts: ${escapeHtml(aug.sp)}</div>` : ''}
        <div>Req level ${aug.l} &nbsp; Rec level ${aug.rl} &nbsp; Era ${escapeHtml(eraText(aug))}</div>
        <div>Classes: ${classList(aug.c)}</div>
        <div class="muted">Click to look it up on Allakhazam</div>`;
}

function placeNear(element, x, y) {
    element.hidden = false;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(x + 12, window.innerWidth - width - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(y + 12, window.innerHeight - height - 4))}px`;
}

function wireAugEvents() {
    const tooltip = $('tooltip');
    document.addEventListener('mouseover', (event) => {
        const link = event.target.closest('a.aug');
        if (!link) { tooltip.hidden = true; return; }
        tooltip.innerHTML = tooltipHtml(optimizer.byId.get(Number(link.dataset.id)));
        placeNear(tooltip, event.clientX, event.clientY);
    });
    document.addEventListener('click', (event) => {
        const toggle = event.target.closest('button.toggle');
        if (toggle) {
            const key = toggle.dataset.socket;
            if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
            renderTabs();
        }
    });
}

// ---------- settings and wiring ----------

function fillSelect(select, options, value) {
    select.innerHTML = options.map(([optionValue, label]) => `<option value="${escapeHtml(optionValue)}">${escapeHtml(label)}</option>`).join('');
    select.value = String(value);
}

function renderSettings() {
    fillSelect($('class'), CLASSES.map(([code, name]) => [code, name]), settings.classCode);
    $('level').value = settings.level;
    const caps = [...new Set(optimizer.expansions.filter((e) => !e.ev).map((e) => e.cap))].sort((a, b) => b - a);
    fillSelect($('era'), [[ALL_ERAS, 'All'], ...caps.map((cap) => [cap, optimizer.eraLabel(cap)]), [0, 'No level req']], settings.eraCap);
    $('andOlder').checked = settings.andOlder;
    $('myClassOnly').checked = settings.myClassOnly;
    $('includeEvents').checked = settings.includeEvents;
    fillSelect($('preset'), [...PRESETS.map((p) => [p.name, `${p.name} (${p.classes.join(' ')})`]), [CUSTOM_PRESET, CUSTOM_PRESET]], settings.preset);
    $('presetSummary').textContent = `(${settings.preset})`;
    $('shieldAc').value = settings.shieldAc;
    $('weights').innerHTML = STATS.map(([key, label]) => `<label>${label} <input type="number" data-weight="${key}" value="${settings.weights[key] || 0}"></label>`).join('');
}

function renderTabs() {
    $('tab-optimizer').innerHTML = optimizerTab();
    $('tab-farm').innerHTML = farmTab();
    $('tab-spells').innerHTML = spellsTab();
}

function recompute() {
    result = inventory ? optimizer.optimize(inventory, runSettings()) : null;
    renderTabs();
    if ($('searchResults').innerHTML) runSearch();
}

let pending = 0;
function changed() {
    saveSettings();
    clearTimeout(pending);
    pending = setTimeout(recompute, 120);
}

function loadInventory(text, name) {
    inventory = parseInventory(text);
    inventoryName = name;
    $('loaded').textContent = inventory.worn.length
        ? `Loaded ${inventoryName}: ${inventory.worn.length} worn items, ${inventory.owned.size} other items.`
        : `${inventoryName} does not look like an inventory file.`;
    storageSet(INVENTORY_KEY, JSON.stringify({ name, text }));
    expanded.clear();
    recompute();
}

function readFile(file) {
    file.text().then((text) => loadInventory(text, file.name));
}

// Any weight edit becomes the user's Custom set, restored whenever Custom is picked again.
function saveCustom() {
    settings.preset = CUSTOM_PRESET;
    settings.custom = { weights: { ...settings.weights }, shieldAc: settings.shieldAc };
    $('preset').value = CUSTOM_PRESET;
    $('presetSummary').textContent = `(${CUSTOM_PRESET})`;
    changed();
}

function wireSettings() {
    $('class').addEventListener('change', () => {
        settings.classCode = $('class').value;
        const preset = classPreset(settings.classCode);
        Object.assign(settings, { preset: preset.name, weights: { ...preset.weights }, shieldAc: preset.shieldAc });
        renderSettings();
        changed();
    });
    $('level').addEventListener('change', () => { settings.level = Number($('level').value) || 1; changed(); });
    $('era').addEventListener('change', () => { settings.eraCap = Number($('era').value); changed(); });
    for (const id of ['andOlder', 'myClassOnly', 'includeEvents']) {
        $(id).addEventListener('change', () => { settings[id] = $(id).checked; changed(); });
    }
    $('preset').addEventListener('change', () => {
        const preset = $('preset').value === CUSTOM_PRESET
            ? { name: CUSTOM_PRESET, ...(settings.custom || { weights: settings.weights, shieldAc: settings.shieldAc }) }
            : PRESETS.find((p) => p.name === $('preset').value);
        Object.assign(settings, { preset: preset.name, weights: { ...preset.weights }, shieldAc: preset.shieldAc });
        // Custom is the user's own set, so show it for editing
        if (preset.name === CUSTOM_PRESET) $('weightsPanel').open = true;
        renderSettings();
        changed();
    });
    $('shieldAc').addEventListener('change', () => {
        settings.shieldAc = Number($('shieldAc').value) || 0;
        saveCustom();
    });
    $('weights').addEventListener('change', (event) => {
        const key = event.target.dataset.weight;
        if (!key) return;
        settings.weights[key] = Number(event.target.value) || 0;
        saveCustom();
    });
    $('searchButton').addEventListener('click', runSearch);

    $('file').addEventListener('change', (event) => event.target.files[0] && readFile(event.target.files[0]));
    const drop = $('drop');
    drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('over');
        if (event.dataTransfer.files[0]) readFile(event.dataTransfer.files[0]);
    });

    $('tabs').addEventListener('click', (event) => {
        const tab = event.target.closest('button[data-tab]');
        if (!tab) return;
        for (const button of $('tabs').querySelectorAll('button')) button.classList.toggle('active', button === tab);
        for (const section of document.querySelectorAll('.tab')) section.hidden = section.id !== `tab-${tab.dataset.tab}`;
    });
}

async function start() {
    const load = (name) => fetch(`data/${name}.json`).then((response) => response.json());
    const [meta, augs, hosts, spells] = await Promise.all(['meta', 'augs', 'hosts', 'spells'].map(load));
    optimizer = new Optimizer({ meta, augs, hosts, spells });
    settings = loadSettings();
    renderSettings();
    wireSettings();
    wireAugEvents();
    const saved = JSON.parse(storageGet(INVENTORY_KEY) || 'null');
    if (saved?.text) loadInventory(saved.text, saved.name);
    else renderTabs();
}

start().catch((error) => {
    $('loaded').textContent = `Could not load aug data: ${error.message}`;
});
