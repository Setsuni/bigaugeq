import {
    ALL_ERAS, CLASSES, Optimizer, PRESETS, PURITY_TARGET, STATS, SYMPATHETIC_KINDS, classList, classPreset, classBow, classSympathetic, classesFromGear, parseInventory,
    restrictionLabel, typesFromMask,
} from './core.js';

const SETTINGS_KEY = 'bisaug.settings';
// Pre-characters save, migrated once
const INVENTORY_KEY = 'bisaug.inventory';
const CHARACTERS_KEY = 'bisaug.characters';
const CURRENT_KEY = 'bisaug.current';
const IGNORED_KEY = 'bisaug.ignored';
const MAX_CHARACTERS = 12;
const CUSTOM_PRESET = 'Custom';
const ALTERNATIVES = 5;
const AUG_TYPE_NAMES = { 3: 'spell', 7: 'general', 8: 'general' };
const touchScreen = window.matchMedia('(hover: none)').matches;

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let optimizer;
let settings;
let inventory = null;
let inventoryName = '';
let characterKey = '';
let characters = {};
let ignored = new Set();
let result = null;
const expanded = new Set();

function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode or storage full */ }
}

function defaultSettings() {
    return {
        classCode: 'SHD', level: 85, eraCap: 85, andOlder: true, myClassOnly: true, includeEvents: false,
        ...presetValues(classPreset('SHD')), ...classSympathetic('SHD'), ...classBow('SHD'),
    };
}

function presetValues(preset) {
    return {
        preset: preset.name, weights: { ...preset.weights }, shieldAc: preset.shieldAc,
    };
}

// Named presets follow their current weights; only Custom keeps the user's own
function withCurrentPreset(loaded) {
    const preset = PRESETS.find((p) => p.name === loaded.preset);
    return preset ? Object.assign(loaded, presetValues(preset)) : loaded;
}

function loadSettings() {
    const saved = JSON.parse(storageGet(SETTINGS_KEY) || 'null');
    const loaded = { ...defaultSettings(), ...(saved || {}) };
    if (saved && saved.sympathetic === undefined) Object.assign(loaded, classSympathetic(loaded.classCode));
    if (saved && saved.bowDamage === undefined) Object.assign(loaded, classBow(loaded.classCode));
    return withCurrentPreset(loaded);
}

function saveSettings() {
    storageSet(SETTINGS_KEY, JSON.stringify(settings));
    if (characters[characterKey]) {
        characters[characterKey].settings = settings;
        saveCharacters();
    }
}

// ---------- characters ----------

const keyForFile = (fileName) => fileName.replace(/(-Inventory)?\.txt$/i, '');

function characterLabel(key) {
    const [name, server] = key.split('_');
    return server ? `${name} · ${server}` : name;
}

function loadCharacters() {
    characters = JSON.parse(storageGet(CHARACTERS_KEY) || 'null') || {};
    const old = JSON.parse(storageGet(INVENTORY_KEY) || 'null');
    if (old?.text && !Object.keys(characters).length) {
        characters[keyForFile(old.name)] = { name: old.name, text: old.text, settings, at: Date.now() };
        storageSet(CURRENT_KEY, keyForFile(old.name));
    }
}

function saveCharacters() {
    const keep = Object.entries(characters).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_CHARACTERS);
    characters = Object.fromEntries(keep);
    storageSet(CHARACTERS_KEY, JSON.stringify(characters));
    storageSet(CURRENT_KEY, characterKey);
}

function charactersHtml() {
    const keys = Object.keys(characters).sort((a, b) => characters[b].at - characters[a].at);
    if (keys.length < 2) return '';
    const rows = keys.map((key) => {
        const saved = characters[key].settings || {};
        const className = CLASSES.find(([code]) => code === saved.classCode)?.[1] || '';
        const what = [className && `${className} ${saved.level}`, saved.preset].filter(Boolean).join(' · ');
        const action = key === characterKey ? '<span class="muted">Current</span>'
            : `<button type="button" data-switch="${escapeHtml(key)}">Switch</button>`;
        return `<li class="${key === characterKey ? 'current' : ''}"><span class="name"><strong>${escapeHtml(characterLabel(key))}</strong></span>
            <span class="muted">${escapeHtml(what)}</span>${action}</li>`;
    }).join('');
    return `<div class="characters"><h3>Your characters <span class="muted">(settings are remembered for each file)</span></h3><ul>${rows}</ul></div>`;
}

function renderLoaded(problem) {
    const loaded = inventory
        ? `<div class="notice"><p>Loaded <strong>${escapeHtml(inventoryName)}</strong>
            <span class="muted">· ${inventory.worn.length} worn items, ${inventory.owned.size} other items · kept in this browser only</span></p>
            <button type="button" id="clearCharacter">Clear</button></div>`
        : '';
    $('loaded').innerHTML = (problem ? `<div class="notice bad" role="alert"><p>${problem}</p></div>` : '') + loaded;
    $('characters').innerHTML = charactersHtml();
}

// Suggestions always fit your class; only Search can show other classes' augs
function runSettings() {
    return { ...settings, myClassOnly: true, classIndex: CLASSES.findIndex(([code]) => code === settings.classCode), ignored };
}

// ---------- ignored augs ----------

const ownsAug = (id) => Boolean(inventory) && (inventory.owned.has(id) || inventory.worn.some((item) => item.augs.some((aug) => aug.id === id)));

// Owned augs are always used, so only ones to farm can be ignored
function ignoreButton(aug) {
    if (ownsAug(aug.id)) return '';
    return `<button type="button" class="ignore" data-ignore="${aug.id}" title="Don't suggest this aug"
        aria-label="Ignore ${escapeHtml(aug.n)}">Ignore</button>`;
}

function saveIgnored() {
    storageSet(IGNORED_KEY, JSON.stringify([...ignored]));
}

function renderIgnored() {
    $('ignoredCount').textContent = ignored.size ? `(${ignored.size})` : '';
    $('ignoredList').innerHTML = [...ignored].map((id) => optimizer.byId.get(id)).filter(Boolean)
        .sort((a, b) => a.n.localeCompare(b.n))
        .map((aug) => `<li>${augLink(aug)} <button type="button" data-unignore="${aug.id}">Undo</button></li>`).join('')
        || '<li class="muted">None yet. Use an Ignore button next to a suggested aug.</li>';
}

function setIgnored(id, on) {
    if (on) ignored.add(id); else ignored.delete(id);
    saveIgnored();
    renderIgnored();
    recompute();
}

// ---------- shared rendering ----------

function augLink(aug, label) {
    const text = escapeHtml(label ?? aug.n);
    if (!optimizer.byId.has(aug.id)) return `<span>${text}</span>`;
    const url = `https://items.eqresource.com/items.php?id=${aug.id}`;
    return `<a class="aug" data-id="${aug.id}" href="${url}" target="_blank" rel="noopener">${text}</a>`;
}

const REPORT_URL = 'https://github.com/Setsuni/bigaugeq/issues/new?template=expansion-correction.yml';

// Link to the correction form with this aug filled in.
function reportHref(aug) {
    const params = new URLSearchParams({ title: `Expansion fix: ${aug.n}`, aug: aug.n, item_id: String(aug.id), current: eraText(aug) });
    return `${REPORT_URL}&${params}`;
}

function reportLink(aug) {
    return ` <a class="report" href="${reportHref(aug)}" target="_blank" rel="noopener" title="Report a wrong expansion">report</a>`;
}

// Focus effect as a small second line under an aug name.
const effectLine = (aug) => (aug.fx ? `<div class="fx">${escapeHtml(aug.fx)}</div>` : '');

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
const SYMPATHETIC_UNITS = { dmg: ' proc dmg', heal: ' proc heal', mana: ' proc mana', hate: ' hate cut' };
const weaponUnit = () => (settings.sympathetic ? SYMPATHETIC_UNITS[settings.sympatheticKind] : ' dmg');
const byDamage = (socket) => socket.profile === 'weapon' || (socket.profile === 'bow' && settings.bowDamage);
const unitFor = (socket) => (socket.profile === 'weapon' ? weaponUnit() : byDamage(socket) ? ' dmg' : '');

function statDelta(aug, current) {
    const parts = STATS.map(([key, label]) => [label, (aug?.s?.[key] || 0) - (current?.s?.[key] || 0)])
        .filter(([, change]) => change).slice(0, 4)
        .map(([label, change]) => `<span class="${change > 0 ? '' : 'bad'}">${change > 0 ? '+' : ''}${change} ${label}</span>`);
    return parts.length ? `<div class="delta">${parts.join(' · ')}</div>` : '';
}

function typeLabel(socket) {
    const name = socket.profile === 'weapon' || socket.profile === 'bow' ? socket.profile : AUG_TYPE_NAMES[socket.augType];
    return name ? `${name} (type ${socket.augType})` : `type ${socket.augType}`;
}

// ---------- optimizer tab ----------

function optimizerTab() {
    if (!result) return '<p class="muted">Load your inventory file to see your aug sockets.</p>';
    if (!result.sockets.length) {
        return `<div class="empty"><p><strong>No aug sockets on your worn gear</strong></p>
            <p class="muted">None of the ${inventory.worn.length} items you're wearing has an aug socket, so there's nothing to optimize yet.</p></div>`;
    }
    const withSource = result.sockets.some((socket) => socket.choice?.aug.src);
    let now = 0;
    let best = 0;
    let damage = 0;
    for (const socket of result.sockets) {
        const current = socket.current?.score || 0;
        const chosen = socket.choice?.score || 0;
        if (byDamage(socket)) damage += chosen - current;
        else { now += current; best += chosen; }
    }
    const rows = result.sockets.map((socket, index) => {
        const choice = socket.choice;
        let optimized = '<span class="muted">-</span>';
        if (choice?.isCurrent) optimized = '<span class="muted">Keep current</span>';
        else if (choice) {
            const note = [choice.movedFrom ? `move from ${choice.movedFrom}` : choice.owned ? `in ${ownedText(choice.owned).toLowerCase()}` : '',
                ].filter(Boolean).join(', ');
            optimized = augLink(choice.aug) + (note ? ` <span class="muted">(${escapeHtml(note)})</span>` : '')
                + (choice.movedFrom ? '' : ignoreButton(choice.aug)) + effectLine(choice.aug);
        }
        if (socket.movedTo && socket.current) {
            optimized += `<br><span class="muted">your ${escapeHtml(socket.current.aug.n)} moves to ${escapeHtml(socket.movedTo)}</span>`;
        }
        let gain = '';
        if (choice) {
            gain = gainHtml(choice.score - (socket.current?.score || 0), unitFor(socket));
            if (!choice.isCurrent && !byDamage(socket)) gain += statDelta(choice.aug, socket.current?.aug);
        }
        const unknown = socket.current && !optimizer.byId.has(socket.current.aug.id)
            ? '<div class="sub warn">Not in our item data, so counted as 0. Gains here may be too high.</div>' : '';
        const current = socket.current ? augLink(socket.current.aug) + effectLine(socket.current.aug) + unknown : '<span class="warn">Empty</span>';
        const source = withSource ? `<td class="wrap">${choice && !choice.isCurrent ? escapeHtml(choice.aug.src || '') : ''}</td>` : null;
        return socketRow(String(index), socket, current, optimized, gain, source);
    }).join('');
    return `<p class="summary">Score ${now} now, ${best} optimized (${gainHtml(best - now)}). ${settings.sympathetic ? 'Weapon sympathetic procs' : 'Weapon damage'} ${gainHtml(damage, weaponUnit())}.
        <span class="muted">Gain is your stat-weight score; the line under it is the actual stat change. Lore augs are used once.
        Augs you already own are always included, whatever expansion you pick; the expansion only limits augs to go get. Expand a slot for more options.</span></p>
        <table><thead><tr><th scope="col">Slot</th><th scope="col">Current</th><th scope="col">Optimized</th><th scope="col" class="num">Gain</th>${withSource ? '<th scope="col">Source</th>' : ''}</tr></thead>
        <tbody>${rows}${twoHandRow(result.twoHand, withSource)}</tbody></table>`;
}

function socketRow(key, socket, current, optimized, gain, source) {
    const open = expanded.has(key);
    const html = `<tr>
        <td><button type="button" class="toggle" data-socket="${key}" aria-expanded="${open}"
            aria-label="${open ? 'Hide' : 'Show'} other options for ${escapeHtml(socket.slotName)}">${open ? '&minus;' : '+'}</button><strong>${escapeHtml(socket.slotName)}</strong>
            <div class="sub">${escapeHtml(socket.itemName)} · ${typeLabel(socket)}</div></td>
        <td>${current}</td><td>${optimized}</td><td class="num">${gain}</td>${source ?? ''}</tr>`;
    return open ? html + alternativesHtml(socket, source != null) : html;
}

// What-if row: the best aug if you swapped to a two-handed weapon.
function twoHandRow(socket, withSource) {
    const choice = socket.choice;
    const optimized = choice
        ? augLink(choice.aug) + (choice.owned ? ` <span class="muted">(in ${escapeHtml(ownedText(choice.owned).toLowerCase())})</span>` : '')
        : '<span class="muted">-</span>';
    const source = withSource ? `<td class="wrap">${escapeHtml(choice?.aug.src || '')}</td>` : null;
    return socketRow('twoHand', socket, '<span class="muted">what-if: any two-handed weapon</span>', optimized,
        choice ? gainHtml(choice.score, weaponUnit()) : '', source);
}

function alternativesHtml(socket, withSource) {
    const others = socket.options.filter((option) => option !== socket.choice).slice(0, ALTERNATIVES);
    const span = withSource ? 4 : 3;
    if (!others.length) return `<tr class="alt"><td></td><td colspan="${span}" class="muted">No other options under these filters.</td></tr>`;
    return others.map((option, index) => {
        const key = Optimizer.optionKey(option);
        const usedIn = key && socket.usedBy.get(key);
        const current = socket.whatIf ? null : socket.current?.aug;
        const gain = usedIn ? `<span class="muted">lore, used in ${escapeHtml(usedIn)}</span>`
            : gainHtml(option.score - (socket.whatIf ? 0 : socket.current?.score || 0), unitFor(socket))
                + (byDamage(socket) ? '' : statDelta(option.aug, current));
        return `<tr class="alt"><td class="muted">#${index + 2}</td><td></td><td>${augLink(option.aug)}${ignoreButton(option.aug)}${effectLine(option.aug)}</td><td class="num">${gain}</td>${withSource
            ? `<td class="wrap">${escapeHtml(option.aug.src || '')}</td>` : ''}</tr>`;
    }).join('');
}

// ---------- swap plan tab ----------

// Below this, a chain's gain is small for the distillers and farming it takes
const SMALL_CHAIN_GAIN = 20;

function sourceNote(step) {
    if (!step.aug) return '';
    if (step.owned) return ` <span class="muted">(in ${escapeHtml(ownedText(step.owned).toLowerCase())})</span>`;
    return ` <span class="warn">(farm${step.aug.src ? `: ${escapeHtml(step.aug.src)}` : ''})</span>${ignoreButton(step.aug)}`;
}

function stepHtml(step) {
    const unit = unitFor(step.kind === 'move' ? step.to : step.socket);
    const gain = `<span class="step-gain">${gainHtml(step.gain, unit)}</span>`;
    if (step.kind === 'move') {
        const replaces = step.replaces ? ` (replacing ${augLink(step.replaces)})` : '';
        return `<li><strong>${escapeHtml(step.from.slotName)}</strong>: take out ${augLink(step.aug)} and put it in
            <strong>${escapeHtml(step.to.slotName)}</strong>${replaces} ${gain}</li>`;
    }
    const what = step.aug ? `put in ${augLink(step.aug)}${sourceNote(step)}` : '<span class="muted">leave empty</span>';
    return `<li><strong>${escapeHtml(step.socket.slotName)}</strong>: ${what} ${gain}</li>`;
}

function planTab() {
    if (!result) return '<p class="muted">Load your inventory file first.</p>';
    const { chains, simple } = Optimizer.swapPlan(result.sockets);
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const chainHtml = chains.map((chain, index) => `
        <div class="chain">
            <h3>Chain ${index + 1}: ${gainHtml(chain.net)}${chain.isCycle ? ' <span class="muted">(swap)</span>' : ''}</h3>
            <p class="muted">${count(chain.distillers, 'distiller')}, ${count(chain.farm, 'aug')} to farm${chain.net < SMALL_CHAIN_GAIN ? ' - <span class="warn">small gain for the work</span>' : ''}</p>
            <ol>${chain.steps.map(stepHtml).join('')}</ol>
        </div>`).join('');
    const simpleRows = simple.map((step) => `<tr><td>${escapeHtml(step.socket.slotName)} <span class="muted">type ${step.socket.augType}</span></td>
        <td>${step.aug ? augLink(step.aug) : '-'}</td><td>${step.aug ? (step.owned ? escapeHtml(ownedText(step.owned)) : '<span class="warn">Farm</span>') : ''}</td>
        <td class="num">${gainHtml(step.gain, unitFor(step.socket))}</td></tr>`).join('');
    return `<p class="muted">The same changes as the Optimizer, as steps. When an aug moves to another slot it sets off a chain of swaps, so each chain shows its net gain.
        Every slot whose aug comes out uses a distiller.</p>
        <h3>Moves</h3>${chainHtml || '<p class="muted">No moves; every change is a simple upgrade.</p>'}
        <h3>Simple upgrades</h3>
        ${simpleRows ? `<table><thead><tr><th>Slot</th><th>Aug</th><th>Get it from</th><th class="num">Gain</th></tr></thead><tbody>${simpleRows}</tbody></table>`
            : '<p class="muted">None.</p>'}`;
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
    const rows = entries.map((entry) => `<tr><td>${augLink(entry.aug)}${owned ? '' : ignoreButton(entry.aug)}</td><td>${escapeHtml(entry.slots.join(', '))}</td>
        <td class="num">${gainHtml(entry.gain, entry.unit)}</td><td>${owned ? escapeHtml(ownedText(entry.owned)) : escapeHtml(eraText(entry.aug)) + reportLink(entry.aug)}</td>
        <td class="wrap">${escapeHtml(entry.aug.src || '')}</td><td class="muted wrap">${escapeHtml(entry.aug.fx || '')}</td></tr>`).join('');
    return `<table><thead><tr><th>Aug</th><th>For</th><th class="num">Gain</th><th>${owned ? 'Where' : 'Era'}</th><th>Source</th><th>Effect</th></tr></thead><tbody>${rows}</tbody></table>`;
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
        <td class="muted">${escapeHtml(entry.aug.fx || '')}</td>
        <td class="${statusClass[entry.status]}">${entry.status}${entry.owned ? ` <span class="muted">(${escapeHtml(ownedText(entry.owned))})</span>` : ''}</td></tr>`)).join('');
    return `<h3>Your type 3 sockets</h3><ul>${sockets || '<li class="muted">None found.</li>'}</ul>
        <h3>Spell augs for ${escapeHtml(CLASSES.find(([code]) => code === settings.classCode)[1])} at level ${settings.level}</h3>
        <p class="muted">The highest spell you can have in each spell line at this level and era, and the augs that boost it.</p>
        <table><thead><tr><th class="num">Level</th><th>Spell</th><th>Expansion</th><th>Aug</th><th>Effect</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- purity tab ----------

function purityRows() {
    return result ? optimizer.purityPlan(inventory, runSettings()) : [];
}

function purityTab() {
    if (!result) return '<p class="muted">Load your inventory file first.</p>';
    const rows = purityRows();
    if (!rows.length) return '<p class="muted">None of your visible armor has a type 14 socket.</p>';
    const sockets = rows.filter((row) => !row.noSocket);
    const done = sockets.filter((row) => row.purity >= PURITY_TARGET).length;
    const empty = sockets.filter((row) => !row.aug).length;
    const fromBags = sockets.filter((row) => row.fix?.owned);
    const chip = (count, label, css) => `<span class="chip"><strong class="${css}">${count}</strong> ${label}</span>`;
    const bagNote = fromBags.length
        ? `<span class="chip ok">You have ${fromBags.length} purity ${PURITY_TARGET}+ aug${fromBags.length === 1 ? '' : 's'} in your bags or bank to fix ${fromBags.length === sockets.length - done ? 'all of them' : 'some of them'}.</span>` : '';
    const body = rows.map((row) => {
        const slot = `<strong>${escapeHtml(row.socket.slotName)}</strong><div class="sub">${escapeHtml(row.socket.itemName)}</div>`;
        if (row.noSocket) return `<tr><td>${slot}</td><td class="muted">No type 14 socket</td><td class="num muted">-</td><td class="muted">-</td></tr>`;
        const css = row.purity >= PURITY_TARGET ? 'good' : row.aug ? 'warn' : 'bad';
        const now = row.aug ? augLink(row.aug) : `<span class="bad">Empty</span>`;
        let todo = '<span class="good">Done</span>';
        if (row.fix) {
            const where = row.fix.owned ? ` <span class="muted">(in ${escapeHtml(row.fix.where.toLowerCase())})</span>` : ignoreButton(row.fix.aug);
            todo = `${row.aug ? 'Swap for' : 'Equip'} ${augLink(row.fix.aug)}${where}`;
        } else if (row.purity < PURITY_TARGET) todo = '<span class="muted">Nothing better at your level</span>';
        return `<tr><td>${slot}</td><td>${now}</td><td class="num ${css}">${row.purity}</td><td class="wrap">${todo}</td></tr>`;
    }).join('');
    return `<p class="summary">Type 14 sockets on your head, chest, arms, wrists, hands, legs and feet. Each should hold a purity ${PURITY_TARGET} aug.</p>
        <div class="chips">${chip(done, `at purity ${PURITY_TARGET}`, 'good')}${chip(sockets.length - done - empty, `below ${PURITY_TARGET}`, 'warn')}${chip(empty, 'empty', 'bad')}${bagNote}</div>
        <table><thead><tr><th scope="col">Slot</th><th scope="col">In the type 14 socket</th><th scope="col" class="num">Purity</th><th scope="col">To do</th></tr></thead>
        <tbody>${body}</tbody></table>`;
}

function renderPurityBadge() {
    const missing = purityRows().filter((row) => !row.noSocket && row.purity < PURITY_TARGET).length;
    $('purityBadge').textContent = missing ? String(missing) : '';
    $('purityBadge').hidden = !missing;
}

// ---------- search tab ----------

function runSearch() {
    const mask = $('searchTypes').value.split(/[^0-9]+/).map(Number).filter((type) => type >= 1 && type <= 30)
        .reduce((total, type) => total | (1 << (type - 1)), 0);
    const rows = mask ? optimizer.rank(mask, { ...runSettings(), myClassOnly: settings.myClassOnly }, Number($('searchLevel').value) || 0, null, 100) : [];
    const weighted = STATS.filter(([key]) => settings.weights[key]);
    $('searchCount').textContent = `${rows.length} results`;
    $('searchResults').innerHTML = `<table><thead><tr><th>Name</th><th>Era</th><th>Types</th><th>Gear</th><th class="num">Score</th>
        ${weighted.map(([, label]) => `<th class="num">${label}</th>`).join('')}<th>Effect</th></tr></thead><tbody>${rows.map(({ aug, score }) => `<tr>
        <td>${augLink(aug)}</td><td>${escapeHtml(eraText(aug))}${reportLink(aug)}</td><td>${typesFromMask(aug.t).join(' ')}</td>
        <td>${restrictionLabel(aug.r)}</td><td class="num">${score}</td>
        ${weighted.map(([key]) => `<td class="num">${aug.s?.[key] || 0}</td>`).join('')}
        <td class="muted">${escapeHtml(aug.fx || '')}</td></tr>`).join('')}</tbody></table>`;
    labelCells($('searchResults'));
}

// ---------- tooltip ----------

function tooltipHtml(aug) {
    const stats = STATS.filter(([key]) => aug.s?.[key]).map(([key, label]) => `${label} ${aug.s[key]}`);
    if (aug.s?.dmg) stats.push(`Weapon Dmg ${aug.s.dmg}`);
    return `<div class="name">${escapeHtml(aug.n)}</div>
        <div>Slot types: ${typesFromMask(aug.t).join(' ')} &nbsp; Gear: ${restrictionLabel(aug.r)}${aug.k ? ' &nbsp; LORE' : ''}</div>
        ${stats.length ? `<div>${stats.join(' &nbsp; ')}</div>` : ''}
        ${aug.sp ? `<div>Boosts: ${escapeHtml(aug.sp)}</div>` : ''}
        ${aug.fx ? `<div>Effect: ${escapeHtml(aug.fx)}</div>` : ''}
        ${aug.src ? `<div>Source: ${escapeHtml(aug.src)}</div>` : ''}
        <div>Req level ${aug.l} &nbsp; Rec level ${aug.rl} &nbsp; Era ${escapeHtml(eraText(aug))}</div>
        <div>Classes: ${classList(aug.c)}</div>
        ${touchScreen
        ? `<div class="actions"><a href="https://items.eqresource.com/items.php?id=${aug.id}" target="_blank" rel="noopener">Open on EQ Resource</a>
            <a href="${reportHref(aug)}" target="_blank" rel="noopener">Report</a></div>`
        : '<div class="muted">Click to look it up on EQ Resource</div>'}`;
}

function placeNear(element, x, y) {
    element.hidden = false;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(x + 12, window.innerWidth - width - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(y + 12, window.innerHeight - height - 4))}px`;
}

function showTooltip(link, x, y, pinned) {
    const tooltip = $('tooltip');
    tooltip.innerHTML = tooltipHtml(optimizer.byId.get(Number(link.dataset.id)));
    tooltip.classList.toggle('pinned', pinned);
    tooltip.dataset.id = link.dataset.id;
    link.setAttribute('aria-describedby', 'tooltip');
    placeNear(tooltip, x, y);
}

function hideTooltip() {
    const tooltip = $('tooltip');
    tooltip.hidden = true;
    tooltip.classList.remove('pinned');
    delete tooltip.dataset.id;
}

function wireAugEvents() {
    const tooltip = $('tooltip');
    document.addEventListener('mouseover', (event) => {
        if (tooltip.classList.contains('pinned')) return;
        const link = event.target.closest('a.aug');
        if (!link) { hideTooltip(); return; }
        showTooltip(link, event.clientX, event.clientY, false);
    });
    document.addEventListener('focusin', (event) => {
        const link = event.target.closest('a.aug');
        if (!link) { if (!tooltip.contains(event.target)) hideTooltip(); return; }
        const box = link.getBoundingClientRect();
        showTooltip(link, box.left, box.bottom, false);
    });
    document.addEventListener('click', (event) => {
        // Touch: first tap shows details instead of leaving the page
        const link = event.target.closest('a.aug');
        if (touchScreen && link) {
            event.preventDefault();
            const box = link.getBoundingClientRect();
            if (tooltip.dataset.id === link.dataset.id && !tooltip.hidden) hideTooltip();
            else showTooltip(link, box.left, box.bottom, true);
            return;
        }
        if (touchScreen && !tooltip.contains(event.target)) hideTooltip();
        const ignore = event.target.closest('button[data-ignore], button[data-unignore]');
        if (ignore) {
            const on = Boolean(ignore.dataset.ignore);
            setIgnored(Number(ignore.dataset.ignore || ignore.dataset.unignore), on);
            return;
        }
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
    const eraName = (cap) => `Level ${cap} · ${optimizer.expansions.filter((e) => e.cap === cap && !e.ev).map((e) => e.n).join(' / ')}`;
    fillSelect($('era'), [[ALL_ERAS, 'All'], ...caps.map((cap) => [cap, eraName(cap)]), [0, 'No level req']], settings.eraCap);
    $('andOlder').checked = settings.andOlder;
    $('myClassOnly').checked = settings.myClassOnly;
    $('includeEvents').checked = settings.includeEvents;
    fillSelect($('preset'), [...PRESETS.map((p) => [p.name, `${p.name} (${p.classes.join(' ')})`]), [CUSTOM_PRESET, CUSTOM_PRESET]], settings.preset);
    $('presetSummary').textContent = `(${settings.preset})`;
    $('shieldAc').value = settings.shieldAc;
    $('weights').innerHTML = STATS.map(([key, label]) => `<label>${label} <input type="number" data-weight="${key}" value="${settings.weights[key] || 0}"></label>`).join('');
    $('sympathetic').checked = settings.sympathetic;
    $('bowDamage').checked = settings.bowDamage;
    fillSelect($('sympatheticKind'), SYMPATHETIC_KINDS, settings.sympatheticKind);
    $('sympatheticKind').disabled = !settings.sympathetic;
}

function labelCells(container) {
    for (const table of container.querySelectorAll('table')) {
        const labels = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        for (const row of table.querySelectorAll('tbody tr')) {
            [...row.cells].forEach((cell, index) => { if (labels[index]) cell.dataset.label = labels[index]; });
        }
    }
}

function renderTabs() {
    $('tab-optimizer').innerHTML = optimizerTab();
    $('tab-plan').innerHTML = planTab();
    $('tab-farm').innerHTML = farmTab();
    $('tab-spells').innerHTML = spellsTab();
    $('tab-purity').innerHTML = purityTab();
    renderPurityBadge();
    for (const id of ['tab-optimizer', 'tab-plan', 'tab-farm', 'tab-spells', 'tab-purity']) labelCells($(id));
}

function recompute() {
    result = inventory ? optimizer.optimize(inventory, runSettings()) : null;
    renderTabs();
    $('characters').innerHTML = charactersHtml();
    if ($('searchResults').innerHTML) runSearch();
}

let pending = 0;
function changed() {
    saveSettings();
    clearTimeout(pending);
    pending = setTimeout(recompute, 120);
}

function loadInventory(text, name) {
    const parsed = parseInventory(text);
    if (!parsed.worn.length) {
        const still = inventory ? ` Your previous file, ${escapeHtml(inventoryName)}, is still loaded.` : '';
        renderLoaded(`<strong>${escapeHtml(name)} isn't an inventory file.</strong> Look for <code>Name_server-Inventory.txt</code>
            in your EverQuest folder, made by <code>/outputfile inventory</code>.${still}`);
        return;
    }
    inventory = parsed;
    inventoryName = name;
    characterKey = keyForFile(name);
    const saved = characters[characterKey]?.settings;
    if (saved) settings = withCurrentPreset({ ...defaultSettings(), ...saved });
    else {
        // A new character starts from its gear's class when the gear only fits one
        const guessed = classesFromGear(parsed, optimizer.hosts);
        settings = { ...settings };
        if (guessed.length === 1 && guessed[0] !== settings.classCode) {
            settings.classCode = guessed[0];
            Object.assign(settings, presetValues(classPreset(guessed[0])), classSympathetic(guessed[0]), classBow(guessed[0]));
        }
    }
    renderSettings();
    characters[characterKey] = { name, text, settings, at: Date.now() };
    saveCharacters();
    saveSettings();
    expanded.clear();
    renderLoaded();
    recompute();
}

function readFile(file) {
    file.text().then((text) => loadInventory(text, file.name))
        .catch((error) => renderLoaded(`<strong>Couldn't read ${escapeHtml(file.name)}:</strong> ${escapeHtml(error.message)}`));
}

function clearCharacter() {
    delete characters[characterKey];
    characterKey = '';
    inventory = null;
    inventoryName = '';
    saveCharacters();
    storageSet(INVENTORY_KEY, '');
    renderLoaded();
    recompute();
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
        Object.assign(settings, presetValues(classPreset(settings.classCode)), classSympathetic(settings.classCode), classBow(settings.classCode));
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
        Object.assign(settings, presetValues(preset));
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
    $('bowDamage').addEventListener('change', () => { settings.bowDamage = $('bowDamage').checked; changed(); });
    $('sympathetic').addEventListener('change', () => {
        settings.sympathetic = $('sympathetic').checked;
        $('sympatheticKind').disabled = !settings.sympathetic;
        changed();
    });
    $('sympatheticKind').addEventListener('change', () => { settings.sympatheticKind = $('sympatheticKind').value; changed(); });
    $('searchButton').addEventListener('click', runSearch);

    $('file').addEventListener('change', (event) => {
        if (event.target.files[0]) readFile(event.target.files[0]);
        event.target.value = '';
    });
    $('upload').addEventListener('click', (event) => {
        if (event.target.id === 'clearCharacter') clearCharacter();
        const key = event.target.dataset.switch;
        if (key && characters[key]) loadInventory(characters[key].text, characters[key].name);
    });

    const overlay = $('dropOverlay');
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    let dragDepth = 0;
    document.addEventListener('dragenter', (event) => {
        if (!hasFiles(event)) return;
        dragDepth += 1;
        overlay.hidden = false;
    });
    document.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) overlay.hidden = true;
    });
    document.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
    document.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        overlay.hidden = true;
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
    try { ignored = new Set(JSON.parse(storageGet(IGNORED_KEY) || '[]')); } catch { ignored = new Set(); }
    loadCharacters();
    renderSettings();
    wireSettings();
    wireAugEvents();
    // Coming back to the page from history: show the saved settings, not whatever the browser kept
    window.addEventListener('pageshow', (event) => { if (event.persisted) { renderSettings(); recompute(); } });
    const current = characters[storageGet(CURRENT_KEY)];
    if (current) loadInventory(current.text, current.name);
    else { renderLoaded(); renderTabs(); }
    renderIgnored();
}

start().catch((error) => {
    $('loaded').textContent = `Could not load aug data: ${error.message}`;
});
