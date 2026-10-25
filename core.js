// Aug optimizer logic: inventory parsing, scoring, filters, optimization. No DOM access here.

export const CLASSES = [
    ['WAR', 'Warrior'], ['CLR', 'Cleric'], ['PAL', 'Paladin'], ['RNG', 'Ranger'],
    ['SHD', 'Shadow Knight'], ['DRU', 'Druid'], ['MNK', 'Monk'], ['BRD', 'Bard'],
    ['ROG', 'Rogue'], ['SHM', 'Shaman'], ['NEC', 'Necromancer'], ['WIZ', 'Wizard'],
    ['MAG', 'Magician'], ['ENC', 'Enchanter'], ['BST', 'Beastlord'], ['BER', 'Berserker'],
];
export const ALL_CLASSES = 65535;

// Worn rows appear in the inventory file in this order, which is also the EQ slot number
export const WORN_SLOTS = [
    'Charm', 'Left Ear', 'Head', 'Face', 'Right Ear', 'Neck', 'Shoulders', 'Arms', 'Back',
    'Left Wrist', 'Right Wrist', 'Range', 'Hands', 'Primary', 'Secondary', 'Left Finger',
    'Right Finger', 'Chest', 'Legs', 'Feet', 'Waist', 'Power Source', 'Ammo',
];
const PRIMARY_SLOT = 13;
const SECONDARY_SLOT = 14;
const LAST_AUG_SLOT = 20;

export const STATS = [
    ['ac', 'AC'], ['hp', 'HP'], ['mana', 'Mana'], ['end', 'End'], ['atk', 'ATK'],
    ['hsta', 'HSta'], ['hstr', 'HStr'], ['hdex', 'HDex'], ['hagi', 'HAgi'], ['hwis', 'HWis'],
    ['hint', 'HInt'], ['hcha', 'HCha'], ['cv', 'Clairvoyance'], ['heal', 'Heal Amt'], ['sd', 'Spell Dmg'],
];

// Focus effects scored per 1% (ranged foci count at their average roll)
export const FOCUS_TYPES = [
    ['dmg', 'Spell dmg %'], ['heal', 'Healing %'], ['haste', 'Spell haste %'],
    ['mana', 'Mana cost %'], ['dur', 'Duration %'], ['range', 'Range %'],
];

// Starting points by role; shieldAc replaces the AC weight in shield sockets.
export const PRESETS = [
    { name: 'Tank', classes: ['WAR', 'PAL', 'SHD'], shieldAc: 15, weights: { ac: 10, hp: 1, hsta: 10 },
        focusWeights: { dmg: 6, haste: 6, mana: 4, dur: 2 } },
    { name: 'Melee DPS', classes: ['MNK', 'ROG', 'BER', 'RNG', 'BST', 'BRD'], shieldAc: 2,
        weights: { hp: 1, ac: 2, atk: 3, hstr: 5, hdex: 5, hagi: 3, hsta: 5 }, focusWeights: {} },
    { name: 'Caster', classes: ['WIZ', 'MAG', 'NEC', 'ENC'], shieldAc: 0,
        weights: { hp: 1, mana: 1, hint: 10, hsta: 5, sd: 3, cv: 3 },
        focusWeights: { dmg: 20, haste: 15, mana: 10, dur: 5, range: 2 } },
    { name: 'Healer', classes: ['CLR', 'DRU', 'SHM'], shieldAc: 5,
        weights: { hp: 1, mana: 1, hwis: 10, hsta: 5, heal: 3, cv: 3 },
        focusWeights: { heal: 20, haste: 15, mana: 10, dur: 5, range: 2 } },
];

// EQ item types: 0 1HS, 1 2HS, 2 1HP, 3 1HB, 4 2HB, 5 bow, 8 shield, 35 2HP, 45 H2H
const WEAPON_TYPES = new Set([0, 1, 2, 3, 4, 5, 35, 45]);
const TWO_HAND_TYPES = [1, 4, 35];
const SHIELD_TYPE = 8;
// Two-handed weapons in reach carry a type 8 socket
const TWO_HAND_AUG_TYPE = 8;

// Gear restriction code -> label and the gear item types it fits. 1 (armor) is anything but weapons and shields.
export const RESTRICTIONS = {
    0: { label: 'Any' },
    1: { label: 'Armor' },
    2: { label: 'Weapons', hostTypes: WEAPON_TYPES },
    3: { label: '1H weapons', hostTypes: new Set([0, 2, 3, 45]) },
    4: { label: '2H weapons', hostTypes: new Set([1, 4, 35]) },
    5: { label: '1H slash', hostTypes: new Set([0]) },
    6: { label: '1H blunt', hostTypes: new Set([3]) },
    7: { label: '1H pierce', hostTypes: new Set([2]) },
    8: { label: 'Hand to hand', hostTypes: new Set([45]) },
    9: { label: '2H slash', hostTypes: new Set([1]) },
    10: { label: '2H blunt', hostTypes: new Set([4]) },
    11: { label: '2H pierce', hostTypes: new Set([35]) },
    12: { label: 'Bows', hostTypes: new Set([5]) },
    13: { label: 'Shields', hostTypes: new Set([SHIELD_TYPE]) },
    14: { label: '1HS/1HB/H2H', hostTypes: new Set([0, 3, 45]) },
    15: { label: '1HB/H2H', hostTypes: new Set([3, 45]) },
};

export const SPELL_AUG_TYPE = 3;
export const ALL_ERAS = -1;
const OPTION_LIMIT = 40;

export const hasBit = (mask, bit) => Math.floor(mask / 2 ** bit) % 2 === 1;

export function typesFromMask(mask) {
    const types = [];
    for (let type = 1; type <= 30; type++) if (hasBit(mask, type - 1)) types.push(type);
    return types;
}

export function classList(classes) {
    if (classes === ALL_CLASSES) return 'ALL';
    return CLASSES.filter((_, index) => hasBit(classes, index)).map(([code]) => code).join(' ');
}

export function classPreset(classCode) {
    return PRESETS.find((preset) => preset.classes.includes(classCode)) || PRESETS[0];
}

export function restrictionLabel(code) {
    return RESTRICTIONS[code]?.label ?? String(code);
}

function restrictionFits(code, hostType) {
    if (hostType === undefined || code === 0) return true;
    if (code === 1) return !WEAPON_TYPES.has(hostType) && hostType !== SHIELD_TYPE;
    const restriction = RESTRICTIONS[code];
    return !restriction?.hostTypes || restriction.hostTypes.has(hostType);
}

// A socket on a real item has one hostType; the 2-hander what-if accepts any two-handed weapon type.
function gearFits(code, socket) {
    if (socket.hostTypes) return socket.hostTypes.some((hostType) => restrictionFits(code, hostType));
    return restrictionFits(code, socket.hostType);
}

// Inventory file from /outputfile inventory: tab-separated Location, Name, ID, Count, Slots.
export function parseInventory(text) {
    const worn = [];
    const owned = new Map();
    let wornIndex = -1;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('KeyRing')) break;
        const [location, name, idText, countText] = line.split('\t');
        const id = Number(idText);
        if (!location || location === 'Location' || !Number.isFinite(id)) continue;
        const socketMatch = location.match(/^([^-]+)-Slot(\d+)$/);
        const isBagOrBank = /^(General|Bank|SharedBank)/.test(location);
        if (!isBagOrBank && !socketMatch && location !== 'Held') {
            wornIndex += 1;
            worn.push({ slot: wornIndex, location, itemId: id, itemName: name, augs: [] });
        } else if (socketMatch && !isBagOrBank && worn.length) {
            const item = worn[worn.length - 1];
            item.augs.push({ index: Number(socketMatch[2]), id, name: id ? name : null });
        } else if (isBagOrBank && id) {
            const where = location.startsWith('General') ? 'Bags' : location.startsWith('SharedBank') ? 'Shared bank' : 'Bank';
            const entries = owned.get(id) || [];
            entries.push({ where, count: Number(countText) || 1 });
            owned.set(id, entries);
        }
    }
    return { worn, owned };
}

export class Optimizer {
    constructor(data) {
        this.augs = data.augs;
        this.hosts = data.hosts;
        this.spells = data.spells;
        this.expansions = data.meta.expansions;
        this.focus = data.focus || {};
        this.byId = new Map(this.augs.map((aug) => [aug.id, aug]));
        this.expansionByCode = new Map(this.expansions.map((expansion) => [expansion.c, expansion]));
    }

    // Known expansion (if any) and era cap. Event augs keep their level-based era.
    effective(aug) {
        const code = aug.x || null;
        return { code, era: aug.e, isEvent: Boolean(code && this.expansionByCode.get(code)?.ev) };
    }

    eraLabel(cap) {
        if (cap === 0) return 'No level req';
        const codes = this.expansions.filter((expansion) => expansion.cap === cap && !expansion.ev).map((e) => e.c);
        return `${cap} (${codes.join(', ')})`;
    }

    weightsFor(profile, settings) {
        if (profile === 'weapon') return { dmg: 1 };
        const weights = { ...settings.weights };
        if (profile === 'shield') weights.ac = settings.shieldAc;
        return weights;
    }

    static score(aug, weights) {
        let total = 0;
        for (const [stat, weight] of Object.entries(weights)) total += (aug.s?.[stat] || 0) * (weight || 0);
        return total;
    }

    // Shared filters: class, level, era and events. Era and events are about getting new augs, so
    // augs you already own (settings.ownedIds) skip them.
    passesFilters(aug, settings, maxLevel) {
        if (settings.myClassOnly && !hasBit(aug.c, settings.classIndex)) return false;
        if (maxLevel > 0 && aug.l > maxLevel) return false;
        if (settings.ownedIds?.has(aug.id)) return true;
        const { era, isEvent } = this.effective(aug);
        if (isEvent && !settings.includeEvents) return false;
        if (settings.eraCap === ALL_ERAS) return true;
        return settings.andOlder ? era <= settings.eraCap : era === settings.eraCap;
    }

    // Top augs for a mask of slot types, best score first. socket narrows to what fits that socket.
    // focusBonus(aug), when given, adds focus value to the ranking; rows keep it apart as `bonus`.
    rank(typeMask, settings, maxLevel, socket, limit = OPTION_LIMIT, focusBonus = null) {
        const weights = this.weightsFor(socket?.profile, settings);
        const tiebreakWeights = this.weightsFor(null, settings);
        const rows = [];
        for (const aug of this.augs) {
            if ((aug.t & typeMask) === 0) continue;
            if (socket && (!hasBit(aug.sl, socket.slot) || !gearFits(aug.r, socket))) continue;
            const score = Optimizer.score(aug, weights);
            const bonus = focusBonus ? focusBonus(aug) : 0;
            if (score + bonus <= 0 || !this.passesFilters(aug, settings, maxLevel)) continue;
            rows.push({ aug, score, bonus, tiebreak: Optimizer.score(aug, tiebreakWeights) });
        }
        rows.sort((a, b) => b.score + b.bonus - a.score - a.bonus || b.tiebreak - a.tiebreak || a.aug.n.localeCompare(b.aug.n));
        return rows.slice(0, limit);
    }

    // A focus only works on spells up to its level limit: full value near your level, half a bit below, none further down.
    static levelFactor(limit, level) {
        if (!limit || limit >= level - 5) return 1;
        return limit >= level - 10 ? 0.5 : 0;
    }

    // Best focus of each type your worn gear (not augs) already gives. Same-type foci don't stack.
    gearFocus(inventory, level) {
        const best = {};
        for (const item of inventory.worn) {
            const focus = this.focus[item.itemId];
            if (!focus) continue;
            const [type, value, limit] = focus;
            best[type] = Math.max(best[type] || 0, value * Optimizer.levelFactor(limit, level));
        }
        return best;
    }

    // Points an aug's focus adds on top of what your gear gives.
    static focusBonus(aug, settings, gearBest) {
        if (!aug.fo) return 0;
        const [type, value, limit] = aug.fo;
        const weight = settings.focusWeights?.[type] || 0;
        const useful = value * Optimizer.levelFactor(limit, settings.level) - (gearBest[type] || 0);
        return useful > 0 ? Math.round(useful * weight) : 0;
    }

    sockets(inventory) {
        const sockets = [];
        for (const item of inventory.worn) {
            if (item.slot > LAST_AUG_SLOT) continue;
            const host = this.hosts[item.itemId];
            const hostType = host ? host[0] : undefined;
            let profile = null;
            if (hostType === SHIELD_TYPE) profile = 'shield';
            else if (WEAPON_TYPES.has(hostType) || (hostType === undefined && item.slot === PRIMARY_SLOT)) profile = 'weapon';
            for (const aug of item.augs) {
                const augType = host ? host[aug.index] : 0;
                if (!augType) continue;
                sockets.push({
                    slot: item.slot, slotName: WORN_SLOTS[item.slot], itemName: item.itemName, hostType, profile, augType,
                    currentId: aug.id || null, currentName: aug.name,
                });
            }
        }
        // Primary and secondary go last
        const order = (socket) => (socket.slot === PRIMARY_SLOT || socket.slot === SECONDARY_SLOT ? socket.slot + 100 : socket.slot);
        return sockets.sort((a, b) => order(a) - order(b) || a.augType - b.augType);
    }

    // An option's "only once" key: its lore group, else its focus type when it is counting its focus.
    static optionKey(option) {
        return option.aug.k || (option.focusBonus ? `F${option.focusType}` : null);
    }

    // Options for a socket. A focus aug appears twice: with its focus value (which can count only once
    // across all sockets) and as a plain stat stick. noFocus lists augs whose focus is already counted elsewhere.
    socketOptions(socket, settings, gearBest, noFocus) {
        const weights = this.weightsFor(socket.profile, settings);
        const bonusFor = (aug) => (socket.profile === 'weapon' || noFocus.has(aug.id) ? 0 : Optimizer.focusBonus(aug, settings, gearBest));
        const variants = (row) => {
            const list = row.score > 0 ? [{ aug: row.aug, score: row.score }] : [];
            if (row.bonus > 0) list.push({ aug: row.aug, score: row.score + row.bonus, focusBonus: row.bonus, focusType: row.aug.fo[0] });
            return list;
        };
        const options = this.rank(2 ** (socket.augType - 1), settings, settings.level, socket, OPTION_LIMIT, bonusFor).flatMap(variants);
        if (socket.currentId) {
            const aug = this.byId.get(socket.currentId) || { id: socket.currentId, n: socket.currentName, s: {} };
            const current = { aug, score: Optimizer.score(aug, weights), bonus: bonusFor(aug) };
            const mine = options.filter((option) => option.aug.id === socket.currentId);
            if (!mine.length) mine.push(...variants(current));
            if (!mine.length) mine.push({ aug, score: 0 });
            for (const option of mine) {
                option.isCurrent = true;
                if (!options.includes(option)) options.push(option);
            }
            // What the slot gives you now, focus included
            socket.current = mine.reduce((best, option) => (option.score > best.score ? option : best));
        }
        // On a tie the aug already in the socket wins, so no pointless swaps
        return options.sort((a, b) => b.score - a.score || Number(Boolean(b.isCurrent)) - Number(Boolean(a.isCurrent)));
    }

    // Each socket can take its best option without an "only once" key freely. Lore groups and counted focus
    // types can be used once across all sockets, so deciding which socket gets each is an assignment problem.
    assign(targets, settings, gearBest, noFocus) {
        const keys = [];
        const keyIndex = new Map();
        const gain = [];
        targets.forEach((socket, index) => {
            socket.options = this.socketOptions(socket, settings, gearBest, noFocus);
            socket.base = socket.options.find((option) => !Optimizer.optionKey(option)) || null;
            socket.bestByKey = new Map();
            for (const option of socket.options) {
                const key = Optimizer.optionKey(option);
                if (key && !socket.bestByKey.has(key)) socket.bestByKey.set(key, option);
            }
            const baseScore = socket.base?.score || 0;
            gain[index] = new Map();
            for (const [key, option] of socket.bestByKey) {
                if (option.score <= baseScore) continue;
                if (!keyIndex.has(key)) {
                    keys.push(key);
                    keyIndex.set(key, keys.length);
                }
                gain[index].set(keyIndex.get(key), option.score - baseScore);
            }
        });
        const match = maxWeightMatching(targets.length, keys.length, gain);
        targets.forEach((socket, index) => {
            const column = match.get(index);
            socket.choice = (column ? socket.bestByKey.get(keys[column - 1]) : socket.base) || null;
        });
    }

    optimize(inventory, baseSettings) {
        const ownedIds = new Set(inventory.owned.keys());
        for (const item of inventory.worn) for (const aug of item.augs) if (aug.id) ownedIds.add(aug.id);
        const settings = { ...baseSettings, ownedIds };
        const all = this.sockets(inventory);
        const targets = all.filter((socket) => socket.augType !== SPELL_AUG_TYPE);
        const wornIn = new Map();
        for (const socket of targets) if (socket.currentId) wornIn.set(socket.currentId, socket.slotName);
        const gearBest = this.gearFocus(inventory, settings.level);

        // A lore aug's key is its lore group, so two different lore augs could each count the same focus
        // type. When that happens, keep the stronger focus and re-run without the others' focus.
        const noFocus = new Set();
        for (let pass = 0; pass < 5; pass++) {
            this.assign(targets, settings, gearBest, noFocus);
            const byType = new Map();
            for (const socket of targets) {
                const choice = socket.choice;
                if (!choice?.focusBonus) continue;
                const list = byType.get(choice.focusType) || [];
                list.push(choice);
                byType.set(choice.focusType, list);
            }
            let repeated = false;
            for (const list of byType.values()) {
                if (list.length < 2) continue;
                list.sort((a, b) => b.focusBonus - a.focusBonus);
                for (const extra of list.slice(1)) noFocus.add(extra.aug.id);
                repeated = true;
            }
            if (!repeated) break;
        }

        const usedBy = new Map();
        for (const socket of targets) {
            const choice = socket.choice;
            if (!choice) continue;
            const key = Optimizer.optionKey(choice);
            if (key) usedBy.set(key, socket.slotName);
            // A lore aug you already wear elsewhere gets moved, not farmed
            if (!choice.isCurrent && choice.aug.k) choice.movedFrom = wornIn.get(choice.aug.id);
            if (!choice.isCurrent && !choice.movedFrom) choice.owned = inventory.owned.get(choice.aug.id) || null;
        }
        // The slot giving up a moved aug shows where it went; its own loss is paid back there
        const socketByCurrent = new Map(targets.filter((socket) => socket.currentId).map((socket) => [socket.currentId, socket]));
        for (const socket of targets) {
            if (!socket.choice?.movedFrom) continue;
            const source = socketByCurrent.get(socket.choice.aug.id);
            if (!source) continue;
            source.movedTo = socket.slotName;
            source.movedToSocket = socket;
            socket.moveSource = source;
        }
        for (const socket of targets) socket.usedBy = usedBy;
        return {
            sockets: targets,
            twoHand: this.twoHandWhatIf(targets, inventory, settings),
            spellSockets: all.filter((socket) => socket.augType === SPELL_AUG_TYPE),
        };
    }

    // Turns an optimize() result into steps: chains of moves (an aug moved out of one slot sets off a run
    // of swaps whose gain only makes sense as a whole) and simple one-slot upgrades.
    static swapPlan(sockets) {
        const gainOf = (socket) => (socket.choice?.score || 0) - (socket.current?.score || 0);
        const changed = (socket) => socket.choice && !socket.choice.isCurrent;
        const fillStep = (socket) => ({
            kind: 'fill', socket, aug: socket.choice?.aug || null, owned: socket.choice?.owned || null, gain: gainOf(socket),
        });
        const chains = [];
        const visited = new Set();
        const walk = (start, isCycle) => {
            const steps = [];
            let socket = start;
            while (socket && !visited.has(socket)) {
                visited.add(socket);
                const source = socket.moveSource;
                if (source) {
                    steps.push({ kind: 'move', aug: socket.choice.aug, from: source, to: socket, replaces: steps.length ? null : socket.current?.aug, gain: gainOf(socket) });
                    socket = source;
                } else {
                    steps.push(fillStep(socket));
                    socket = null;
                }
            }
            const members = steps.flatMap((step) => (step.kind === 'move' ? [step.to] : [step.socket]));
            chains.push({
                steps, isCycle,
                net: steps.reduce((total, step) => total + step.gain, 0),
                // Every changed slot that held an aug needs it removed first
                distillers: members.filter((socket) => socket.current).length,
                farm: steps.filter((step) => step.kind === 'fill' && step.aug && !step.owned).length,
            });
        };
        // A chain starts at the slot that receives a moved aug while its own aug isn't moved anywhere
        for (const socket of sockets) if (socket.moveSource && !socket.movedToSocket) walk(socket, false);
        // Whatever is left of the moves is a closed swap (A to B, B to A)
        for (const socket of sockets) if (socket.moveSource && !visited.has(socket)) walk(socket, true);
        chains.sort((a, b) => b.net - a.net);

        const simple = sockets.filter((socket) => changed(socket) && !visited.has(socket) && !socket.movedToSocket)
            .map((socket) => ({ ...fillStep(socket), distillers: socket.current ? 1 : 0 }))
            .sort((a, b) => b.gain - a.gain);
        return { chains, simple };
    }

    // Best aug for a two-handed weapon you might swap to. It replaces the primary and secondary, so only
    // lore augs placed in other slots are off limits.
    twoHandWhatIf(targets, inventory, settings) {
        const socket = {
            slot: PRIMARY_SLOT, slotName: '2-Hander', itemName: 'Any two-handed weapon', hostTypes: TWO_HAND_TYPES,
            profile: 'weapon', augType: TWO_HAND_AUG_TYPE, whatIf: true,
        };
        socket.usedBy = new Map();
        for (const other of targets) {
            const key = other.choice?.aug.k;
            if (key && other.slot !== PRIMARY_SLOT && other.slot !== SECONDARY_SLOT) socket.usedBy.set(key, other.slotName);
        }
        socket.options = this.rank(2 ** (TWO_HAND_AUG_TYPE - 1), settings, settings.level, socket);
        socket.choice = socket.options.find((option) => !option.aug.k || !socket.usedBy.has(option.aug.k)) || null;
        if (socket.choice) socket.choice.owned = inventory.owned.get(socket.choice.aug.id) || null;
        return socket;
    }

    // Type 3 augs for the class: at the chosen level and era, the highest spell in each line and its augs.
    spellAugs(inventory, settings) {
        const classIndex = settings.classIndex;
        const worn = new Set(inventory.worn.flatMap((item) => item.augs.map((aug) => aug.id)).filter(Boolean));
        const lines = new Map();
        for (const aug of this.augs) {
            if (!aug.sp || aug.c === ALL_CLASSES || !hasBit(aug.c, classIndex)) continue;
            const spell = this.spells[aug.sp];
            const level = spell?.[1]?.[classIndex];
            if (!level || level === 255 || level > settings.level) continue;
            const spellExpansion = spell[2] && this.expansionByCode.get(spell[2]);
            if (spellExpansion && settings.eraCap !== ALL_ERAS && spellExpansion.cap > settings.eraCap) continue;
            const key = spell[0];
            let line = lines.get(key);
            if (!line || level > line.level) {
                line = { spell: aug.sp, level, expansion: spell[2] || null, augs: [] };
                lines.set(key, line);
            }
            if (line.spell !== aug.sp) continue;
            line.augs.push({
                aug,
                status: worn.has(aug.id) ? 'Worn' : inventory.owned.has(aug.id) ? 'Owned' : 'Missing',
                owned: inventory.owned.get(aug.id) || null,
            });
        }
        return [...lines.values()].sort((a, b) => b.level - a.level || a.spell.localeCompare(b.spell));
    }
}

// Hungarian algorithm: pairs rows with columns to maximize total gain, each column used at most once.
// gain[row] is a Map of column (1-based) -> gain. Returns Map row (0-based) -> column (1-based).
export function maxWeightMatching(rowCount, columnCount, gain) {
    // Extra zero-gain columns let any row stay unmatched
    const width = columnCount + rowCount;
    const rowPotential = new Array(rowCount + 1).fill(0);
    const columnPotential = new Array(width + 1).fill(0);
    const columnOwner = new Array(width + 1).fill(0);
    const previous = new Array(width + 1).fill(0);
    const gainOf = (row, column) => (column <= columnCount ? gain[row - 1].get(column) || 0 : 0);
    for (let row = 1; row <= rowCount; row++) {
        columnOwner[0] = row;
        let column = 0;
        const slack = new Array(width + 1).fill(Infinity);
        const used = new Array(width + 1).fill(false);
        do {
            used[column] = true;
            const owner = columnOwner[column];
            let delta = Infinity;
            let nextColumn = 0;
            for (let j = 1; j <= width; j++) {
                if (used[j]) continue;
                const cost = -gainOf(owner, j) - rowPotential[owner] - columnPotential[j];
                if (cost < slack[j]) {
                    slack[j] = cost;
                    previous[j] = column;
                }
                if (slack[j] < delta) {
                    delta = slack[j];
                    nextColumn = j;
                }
            }
            for (let j = 0; j <= width; j++) {
                if (used[j]) {
                    rowPotential[columnOwner[j]] += delta;
                    columnPotential[j] -= delta;
                } else {
                    slack[j] -= delta;
                }
            }
            column = nextColumn;
        } while (columnOwner[column] !== 0);
        do {
            const prior = previous[column];
            columnOwner[column] = columnOwner[prior];
            column = prior;
        } while (column !== 0);
    }
    const match = new Map();
    for (let column = 1; column <= columnCount; column++) {
        const row = columnOwner[column];
        if (row > 0 && gainOf(row, column) > 0) match.set(row - 1, column);
    }
    return match;
}
