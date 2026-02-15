const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;
const MAP_W = 3000;
const MAP_H = 3000;
const TANK_SIZE = 24;
const BULLET_SPEED = 12;
const BULLET_LIFETIME = 90;
const FIRE_COOLDOWN = 20;
const RAPID_COOLDOWN = 4;
const DMG_MIN = 15;
const DMG_MAX = 25;
const BASE_SPEED = 3;
const MAX_SPEED_MULT = 5;
const RESPAWN_DELAY = 3000;
const SPAWN_SHIELD_TICKS = 150; // 5 секунд при 30 тиках
const MAX_PLAYERS = 50;
const MAX_CHAT_LEN = 120;
const CHAT_COOLDOWN = 500;
const MAX_CHAT_HISTORY = 50;
const AFK_TIMEOUT = 60000;
const AFK_CHECK_INTERVAL = 5000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let nextId = 1;
const players = new Map();
const bullets = [];
const buildings = [];
let killFeed = [];
let chatHistory = [];
let tickCount = 0;

function uid() { return nextId++; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function normAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
function rectCol(ax, ay, aw, ah, bx, by, bw, bh) { return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by; }
function tankHitsBuilding(tx, ty, ghost) {
    if (ghost) return false;
    for (const b of buildings) {
        if (rectCol(tx - TANK_SIZE, ty - TANK_SIZE, TANK_SIZE * 2, TANK_SIZE * 2, b.x, b.y, b.w, b.h)) return true;
    }
    return false;
}
function ptInBuilding(px, py) {
    for (const b of buildings) { if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return true; }
    return false;
}
function findSpawn() {
    for (let i = 0; i < 300; i++) {
        const x = 100 + Math.random() * (MAP_W - 200);
        const y = 100 + Math.random() * (MAP_H - 200);
        if (!tankHitsBuilding(x, y, false)) {
            let close = false;
            for (const [, p] of players) { if (p.alive && dist({ x, y }, p) < 200) { close = true; break; } }
            if (!close) return { x, y };
        }
    }
    return { x: MAP_W / 2, y: MAP_H / 2 };
}
function sanitize(s) { return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])); }

function generateBuildings() {
    buildings.length = 0;
    const tpl = [
        { w: 80, h: 80 }, { w: 120, h: 60 }, { w: 60, h: 120 },
        { w: 100, h: 100 }, { w: 50, h: 150 }, { w: 150, h: 50 },
        { w: 70, h: 70 }, { w: 40, h: 40 }, { w: 90, h: 130 }
    ];
    for (let i = 0; i < 40; i++) {
        const t = tpl[Math.floor(Math.random() * tpl.length)];
        let bx, by, ok, att = 0;
        do {
            bx = 100 + Math.random() * (MAP_W - 200 - t.w);
            by = 100 + Math.random() * (MAP_H - 200 - t.h);
            ok = !buildings.some(b => Math.abs(bx - b.x) < b.w + t.w + 80 && Math.abs(by - b.y) < b.h + t.h + 80);
            att++;
        } while (!ok && att < 50);
        buildings.push({ x: bx, y: by, w: t.w, h: t.h, color: `hsl(${200 + Math.random() * 40},10%,${15 + Math.random() * 10}%)` });
    }
}

function createPlayer(id, name) {
    const sp = findSpawn();
    return {
        id, name: name.substring(0, 16),
        x: sp.x, y: sp.y,
        angle: 0, turretAngle: 0, displayAngle: 0,
        hp: 100, maxHp: 100,
        kills: 0, deaths: 0, killStreak: 0, bestStreak: 0,
        alive: true,
        // customization
        bodyColor: '#00c8ff',
        turretColor: '#00a0dd',
        trackColor: '#333333',
        bulletColor: '#00ffff',
        tankShape: 'default',
        barrelLength: 35,
        barrelWidth: 8,
        turretSize: 12,

        fireCooldown: 0,
        // spawn shield
        spawnShield: SPAWN_SHIELD_TICKS,

        input: { up: false, down: false, left: false, right: false, fire: false, mouseAngle: 0 },
        cheats: {
            aimbot: false, aimfov: 180, smooth: false, triggerbot: false,
            autofire: false, silentaim: false, prediction: false,
            speed: false, speedval: 2, rapidfire: false, norecoil: false,
            ghost: false, autododge: false,
            spinbot: false, spinspeed: 15, desync: false, fakelag: false,
            resolver: false, backtrack: false
        },
        desyncOffset: 0,
        fakelagCounter: 0,
        fakelagPos: { x: sp.x, y: sp.y },
        posHistory: [],
        ws: null,
        lastPing: Date.now(),
        lastChat: 0,
        joinTime: Date.now(),
        lastActivity: Date.now(),
        lastInputState: null,
        afkWarned: false,
        paused: false
    };
}

// AFK
function checkAFK() {
    const now = Date.now();
    for (const [id, p] of players) {
        if (p.paused) continue;
        const idle = now - p.lastActivity;
        if (idle > AFK_TIMEOUT - 15000 && !p.afkWarned) {
            p.afkWarned = true;
            sendTo(p.ws, { type: 'sysChat', text: '⚠️ Кик через 15 сек за AFK!', color: '#ffcc00' });
        }
        if (idle > AFK_TIMEOUT) {
            console.log(`[AFK] ${p.name} kicked`);
            sendTo(p.ws, { type: 'kicked', reason: 'AFK — неактивность более 1 минуты' });
            broadcast({ type: 'sysChat', text: `${p.name} кикнут за AFK`, color: '#ff8800' });
            if (p.ws) p.ws.close();
            players.delete(id);
        }
    }
}

function updateActivity(player, inputMsg) {
    const newState = `${inputMsg.up}${inputMsg.down}${inputMsg.left}${inputMsg.right}${inputMsg.fire}${Math.round(inputMsg.mouseAngle * 100)}`;
    if (player.lastInputState !== newState) {
        player.lastActivity = Date.now();
        player.afkWarned = false;
        player.lastInputState = newState;
    }
}

// TICK
function tick() {
    tickCount++;
    const all = [...players.values()];

    for (const p of all) {
        if (!p.alive) continue;
        if (p.paused) continue;

        // spawn shield countdown
        if (p.spawnShield > 0) {
            p.spawnShield--;
            // если игрок стреляет, щит снимается
            if (p.input.fire || p.cheats.autofire) {
                p.spawnShield = 0;
            }
        }

        p.posHistory.push({ x: p.x, y: p.y });
        if (p.posHistory.length > 20) p.posHistory.shift();

        let spd = BASE_SPEED;
        if (p.cheats.speed) spd *= clamp(p.cheats.speedval, 1, MAX_SPEED_MULT);

        let dx = 0, dy = 0;
        if (p.input.up) dy -= spd;
        if (p.input.down) dy += spd;
        if (p.input.left) dx -= spd;
        if (p.input.right) dx += spd;

        if (p.cheats.autododge) {
            for (const b of bullets) {
                if (b.ownerId === p.id) continue;
                const d = dist(b, p);
                if (d < 90) { const perp = b.angle + Math.PI / 2; dx += Math.cos(perp) * 5; dy += Math.sin(perp) * 5; }
            }
        }
        if (dx && dy) { const len = Math.hypot(dx, dy); dx = (dx / len) * spd; dy = (dy / len) * spd; }

        let nx = clamp(p.x + dx, TANK_SIZE, MAP_W - TANK_SIZE);
        let ny = clamp(p.y + dy, TANK_SIZE, MAP_H - TANK_SIZE);
        if (!tankHitsBuilding(nx, p.y, p.cheats.ghost)) p.x = nx;
        if (!tankHitsBuilding(p.x, ny, p.cheats.ghost)) p.y = ny;

        // aimbot
        if (p.cheats.aimbot) {
            let closest = null, cd = Infinity;
            for (const t of all) {
                if (t.id === p.id || !t.alive || t.paused) continue;
                let tx = t.x, ty = t.y;
                if (p.cheats.resolver) { tx = t.x; ty = t.y; }
                else { if (t.cheats.fakelag) { tx = t.fakelagPos.x; ty = t.fakelagPos.y; } if (t.cheats.desync) tx += t.desyncOffset; }
                const dd = dist(p, { x: tx, y: ty });
                const ang = Math.atan2(ty - p.y, tx - p.x);
                const diff = Math.abs(normAngle(ang - p.input.mouseAngle));
                if (diff < (p.cheats.aimfov * Math.PI / 360) && dd < cd) { cd = dd; closest = { x: tx, y: ty, t }; }
            }
            if (closest) {
                let tAngle = Math.atan2(closest.y - p.y, closest.x - p.x);
                if (p.cheats.prediction && closest.t) {
                    const d2 = dist(p, closest);
                    const tt = d2 / BULLET_SPEED;
                    const h = closest.t.posHistory;
                    if (h.length >= 2) {
                        const l = h[h.length - 1], pr = h[h.length - 2];
                        tAngle = Math.atan2(closest.y + (l.y - pr.y) * TICK_RATE * tt / TICK_RATE - p.y,
                            closest.x + (l.x - pr.x) * TICK_RATE * tt / TICK_RATE - p.x);
                    }
                }
                if (p.cheats.smooth) p.turretAngle += normAngle(tAngle - p.turretAngle) * 0.3;
                else p.turretAngle = tAngle;
            } else p.turretAngle = p.input.mouseAngle;
        } else p.turretAngle = p.input.mouseAngle;

        if (p.cheats.spinbot) p.displayAngle = (tickCount * p.cheats.spinspeed * 0.1) % (Math.PI * 2);
        else p.displayAngle = p.turretAngle;

        p.desyncOffset = p.cheats.desync ? Math.sin(tickCount * 0.15 + p.id) * 18 : 0;

        if (p.cheats.fakelag) { p.fakelagCounter++; if (p.fakelagCounter % 8 < 4) p.fakelagPos = { x: p.x, y: p.y }; }
        else p.fakelagPos = { x: p.x, y: p.y };

        p.fireCooldown = Math.max(0, p.fireCooldown - 1);
        const cdReq = p.cheats.rapidfire ? RAPID_COOLDOWN : FIRE_COOLDOWN;

        let shouldFire = p.input.fire || p.cheats.autofire;
        if (p.cheats.triggerbot) {
            for (const t of all) {
                if (t.id === p.id || !t.alive || t.paused) continue;
                if (dist(p, t) < 500) {
                    const ang = Math.atan2(t.y - p.y, t.x - p.x);
                    if (Math.abs(normAngle(ang - p.turretAngle)) < 0.18) { shouldFire = true; break; }
                }
            }
        }

        if (shouldFire && p.fireCooldown <= 0) {
            // стрельба снимает spawn shield
            p.spawnShield = 0;

            let fireAngle = p.turretAngle;
            if (p.cheats.silentaim) {
                let cl = null, cd2 = Infinity;
                for (const t of all) {
                    if (t.id === p.id || !t.alive || t.paused) continue;
                    const dd = dist(p, t); if (dd < cd2) { cd2 = dd; cl = t; }
                }
                if (cl && cd2 < 700) fireAngle = Math.atan2(cl.y - p.y, cl.x - p.x);
            }
            spawnBullet(p, fireAngle);
            p.fireCooldown = cdReq;
            if (!p.cheats.norecoil) { p.x -= Math.cos(fireAngle) * 2; p.y -= Math.sin(fireAngle) * 2; }
            broadcastNear(p.x, p.y, 800, { type: 'sfx', sfx: 'shoot', x: p.x, y: p.y });
        }
    }

    // bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx; b.y += b.vy; b.life--;

        let remove = false;
        if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) remove = true;
        if (!remove && ptInBuilding(b.x, b.y)) { remove = true; broadcastNear(b.x, b.y, 600, { type: 'sfx', sfx: 'wallhit', x: b.x, y: b.y }); }

        if (!remove) {
            for (const t of all) {
                if (t.id === b.ownerId || !t.alive || t.paused) continue;
                // spawn shield — неуязвимость
                if (t.spawnShield > 0) continue;

                let hit = dist(b, t) < TANK_SIZE;
                if (!hit && findOwner(b.ownerId)?.cheats?.backtrack) {
                    for (const pos of t.posHistory) { if (Math.hypot(b.x - pos.x, b.y - pos.y) < TANK_SIZE) { hit = true; break; } }
                }

                if (hit) {
                    t.hp -= b.damage;
                    remove = true;
                    broadcastNear(t.x, t.y, 600, { type: 'sfx', sfx: 'hit', x: t.x, y: t.y });

                    if (t.hp <= 0) {
                        t.alive = false; t.deaths++; t.killStreak = 0;
                        const killer = findOwner(b.ownerId);
                        if (killer) { killer.kills++; killer.killStreak++; if (killer.killStreak > killer.bestStreak) killer.bestStreak = killer.killStreak; }
                        const entry = { killer: killer ? killer.name : '???', victim: t.name, time: Date.now(), streak: killer ? killer.killStreak : 0 };
                        killFeed.push(entry); if (killFeed.length > 20) killFeed.shift();
                        broadcast({ type: 'kill', killer: killer ? killer.name : '???', killerId: killer ? killer.id : -1, victim: t.name, victimId: t.id, streak: entry.streak });
                        broadcastNear(t.x, t.y, 1000, { type: 'sfx', sfx: 'explode', x: t.x, y: t.y });
                        setTimeout(() => { if (!t.alive) respawnEntity(t); }, RESPAWN_DELAY);
                    }
                    break;
                }
            }
        }
        if (remove) bullets.splice(i, 1);
    }

    broadcastState();
}

function findOwner(id) { return players.get(id) || null; }

function spawnBullet(owner, angle) {
    const sx = owner.x + Math.cos(angle) * (owner.barrelLength || 35);
    const sy = owner.y + Math.sin(angle) * (owner.barrelLength || 35);
    bullets.push({
        id: uid(), x: sx, y: sy,
        vx: Math.cos(angle) * BULLET_SPEED, vy: Math.sin(angle) * BULLET_SPEED,
        angle, ownerId: owner.id, ownerColor: owner.bulletColor || owner.bodyColor,
        life: BULLET_LIFETIME,
        damage: DMG_MIN + Math.random() * (DMG_MAX - DMG_MIN)
    });
}

function respawnEntity(e) {
    const sp = findSpawn();
    e.x = sp.x; e.y = sp.y; e.hp = e.maxHp; e.alive = true;
    e.posHistory = []; e.fakelagPos = { x: sp.x, y: sp.y };
    e.spawnShield = SPAWN_SHIELD_TICKS; // щит на 5 сек
}

// NETWORK
function serialize(p) {
    return {
        id: p.id, name: p.name,
        x: p.cheats.fakelag ? p.fakelagPos.x : p.x,
        y: p.cheats.fakelag ? p.fakelagPos.y : p.y,
        realX: p.x, realY: p.y,
        angle: p.displayAngle, turretAngle: p.turretAngle,
        hp: p.hp, maxHp: p.maxHp,
        kills: p.kills, deaths: p.deaths,
        killStreak: p.killStreak, bestStreak: p.bestStreak,
        alive: p.alive,
        bodyColor: p.bodyColor, turretColor: p.turretColor,
        trackColor: p.trackColor, bulletColor: p.bulletColor,
        tankShape: p.tankShape,
        barrelLength: p.barrelLength, barrelWidth: p.barrelWidth, turretSize: p.turretSize,
        desyncOffset: p.desyncOffset,
        spawnShield: p.spawnShield > 0,
        paused: p.paused,
        cheats: { spinbot: p.cheats.spinbot, desync: p.cheats.desync, fakelag: p.cheats.fakelag },
        posHistory: (p.cheats.fakelag || p.cheats.desync) ? p.posHistory.slice(-5) : []
    };
}

function broadcastState() {
    const pArr = [...players.values()];
    const state = {
        type: 'state', tick: tickCount,
        players: pArr.map(serialize),
        bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, angle: b.angle, ownerId: b.ownerId, ownerColor: b.ownerColor }))
    };
    const data = JSON.stringify(state);
    for (const [, p] of players) {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) { try { p.ws.send(data); } catch (e) {} }
    }
}

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const [, p] of players) {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) { try { p.ws.send(data); } catch (e) {} }
    }
}

function broadcastNear(x, y, radius, msg) {
    const data = JSON.stringify(msg);
    for (const [, p] of players) {
        if (p.ws && p.ws.readyState === WebSocket.OPEN && Math.hypot(p.x - x, p.y - y) < radius) {
            try { p.ws.send(data); } catch (e) {}
        }
    }
}

function sendTo(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
}

// WS
wss.on('connection', (ws) => {
    if (players.size >= MAX_PLAYERS) { ws.close(1013, 'Full'); return; }
    let player = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'join': {
                const id = uid();
                const name = sanitize((msg.name || 'Player').substring(0, 16));
                player = createPlayer(id, name);
                player.ws = ws;
                // apply customization from login
                if (msg.custom) {
                    const d = msg.custom;
                    if (d.bodyColor && /^#[0-9a-fA-F]{6}$/.test(d.bodyColor)) player.bodyColor = d.bodyColor;
                    if (d.turretColor && /^#[0-9a-fA-F]{6}$/.test(d.turretColor)) player.turretColor = d.turretColor;
                    if (d.trackColor && /^#[0-9a-fA-F]{6}$/.test(d.trackColor)) player.trackColor = d.trackColor;
                    if (d.bulletColor && /^#[0-9a-fA-F]{6}$/.test(d.bulletColor)) player.bulletColor = d.bulletColor;
                    if (['default', 'rounded', 'angular', 'heavy'].includes(d.tankShape)) player.tankShape = d.tankShape;
                    if (d.barrelLength != null) player.barrelLength = clamp(+d.barrelLength, 20, 50);
                    if (d.barrelWidth != null) player.barrelWidth = clamp(+d.barrelWidth, 4, 14);
                    if (d.turretSize != null) player.turretSize = clamp(+d.turretSize, 8, 18);
                }
                players.set(id, player);
                console.log(`[+] ${name} (id=${id}) — ${players.size} online`);
                sendTo(ws, {
                    type: 'init', id: player.id, mapW: MAP_W, mapH: MAP_H,
                    buildings: buildings.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h, color: b.color })),
                    killFeed: killFeed.slice(-10),
                    chatHistory: chatHistory.slice(-30)
                });
                broadcast({ type: 'sysChat', text: `${name} присоединился`, color: '#00c8ff' });
                break;
            }
            case 'input': {
                if (!player) return;
                updateActivity(player, msg);
                player.input.up = !!msg.up; player.input.down = !!msg.down;
                player.input.left = !!msg.left; player.input.right = !!msg.right;
                player.input.fire = !!msg.fire;
                player.input.mouseAngle = Number(msg.mouseAngle) || 0;
                break;
            }
            case 'cheats': {
                if (!player) return;
                player.lastActivity = Date.now(); player.afkWarned = false;
                const c = msg.cheats; if (!c) return;
                const pc = player.cheats;
                pc.aimbot = !!c.aimbot; pc.aimfov = clamp(+c.aimfov || 180, 10, 360);
                pc.smooth = !!c.smooth; pc.triggerbot = !!c.triggerbot;
                pc.autofire = !!c.autofire; pc.silentaim = !!c.silentaim;
                pc.prediction = !!c.prediction;
                pc.speed = !!c.speed; pc.speedval = clamp(+c.speedval || 2, 1, MAX_SPEED_MULT);
                pc.rapidfire = !!c.rapidfire; pc.norecoil = !!c.norecoil;
                pc.ghost = !!c.ghost; pc.autododge = !!c.autododge;
                pc.spinbot = !!c.spinbot; pc.spinspeed = clamp(+c.spinspeed || 15, 1, 30);
                pc.desync = !!c.desync; pc.fakelag = !!c.fakelag;
                pc.resolver = !!c.resolver; pc.backtrack = !!c.backtrack;
                break;
            }
            case 'customize': {
                if (!player) return;
                player.lastActivity = Date.now(); player.afkWarned = false;
                const d = msg.data; if (!d) return;
                if (d.bodyColor && /^#[0-9a-fA-F]{6}$/.test(d.bodyColor)) player.bodyColor = d.bodyColor;
                if (d.turretColor && /^#[0-9a-fA-F]{6}$/.test(d.turretColor)) player.turretColor = d.turretColor;
                if (d.trackColor && /^#[0-9a-fA-F]{6}$/.test(d.trackColor)) player.trackColor = d.trackColor;
                if (d.bulletColor && /^#[0-9a-fA-F]{6}$/.test(d.bulletColor)) player.bulletColor = d.bulletColor;
                if (['default', 'rounded', 'angular', 'heavy'].includes(d.tankShape)) player.tankShape = d.tankShape;
                if (d.barrelLength != null) player.barrelLength = clamp(+d.barrelLength, 20, 50);
                if (d.barrelWidth != null) player.barrelWidth = clamp(+d.barrelWidth, 4, 14);
                if (d.turretSize != null) player.turretSize = clamp(+d.turretSize, 8, 18);
                break;
            }
            case 'pause': {
                if (!player) return;
                player.paused = !!msg.paused;
                player.lastActivity = Date.now(); player.afkWarned = false;
                if (player.paused) player.input = { up: false, down: false, left: false, right: false, fire: false, mouseAngle: player.input.mouseAngle };
                broadcast({ type: 'sysChat', text: `${player.name} ${player.paused ? '⏸ на паузе' : '▶ вернулся'}`, color: '#888' });
                break;
            }
            case 'ping': {
                sendTo(ws, { type: 'pong', t: msg.t });
                if (player) player.lastPing = Date.now();
                break;
            }
            case 'respawn': {
                if (player && !player.alive) respawnEntity(player);
                break;
            }
            case 'chat': {
                if (!player) return;
                player.lastActivity = Date.now(); player.afkWarned = false;
                const now = Date.now();
                if (now - player.lastChat < CHAT_COOLDOWN) return;
                player.lastChat = now;
                const text = sanitize(String(msg.text || '').substring(0, MAX_CHAT_LEN)).trim();
                if (!text) return;
                const entry = { name: player.name, text, color: player.bodyColor, time: now };
                chatHistory.push(entry); if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
                broadcast({ type: 'chat', name: player.name, text, color: player.bodyColor });
                break;
            }
        }
    });

    ws.on('close', () => {
        if (player) {
            console.log(`[-] ${player.name} left`);
            broadcast({ type: 'sysChat', text: `${player.name} покинул игру`, color: '#ff0040' });
            players.delete(player.id);
        }
    });
    ws.on('error', () => { if (player) players.delete(player.id); });
});

generateBuildings();
setInterval(tick, TICK_MS);
setInterval(checkAFK, AFK_CHECK_INTERVAL);
setInterval(() => {
    const now = Date.now();
    for (const [id, p] of players) {
        if (now - p.lastPing > 30000) {
            console.log(`[x] ${p.name} timeout`); if (p.ws) p.ws.close(); players.delete(id);
        }
    }
}, 10000);

server.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`  TankCheat.io v4 — port ${PORT}`);
    console.log(`  http://localhost:${PORT}`);
    console.log('='.repeat(50));
});