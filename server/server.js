// server.js — Clicker de Guerra (Multiplayer PvP)
// Node.js + Express + Socket.IO (servidor autoritativo)
// Atualizações:
// - Zonas continuam no cliente (rosa dos ventos, labels) — apenas visual.
// - Assassino: invisibilidade aumentada (5s).
// - Golem: mais vida (300) e mais dano da rocha (50).
// - Auto-hit curto alcance mantido (assassino/guerreiro/dragonite).
// - Lorde: drone auto-alvo se não houver alvo travado.
// - Pickups verdes aleatórios que curam totalmente (máx 4 simultâneos).
// - Snapshot inclui timers para HUD (dashCdLeft, invisCdLeft, rockCdLeft, berserkCdLeft etc.).

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

// === Config ===
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;

const WORLD = { w: 2800, h: 1800 };
const OBSTACLES = [
  { x: 600, y: 400, w: 260, h: 120 },
  { x: 1300, y: 900, w: 220, h: 220 },
  { x: 1850, y: 500, w: 300, h: 140 },
  { x: 2200, y: 1300, w: 180, h: 300 },
  { x: 900, y: 1300, w: 280, h: 120 },
];

// === Balance por classe ===
const CLASSES = {
  arqueiro: {
    r: 18, speed: 240, maxHp: 100,
    range: 460, dmg: 16, cdBase: 0.40,
    projSpeed: 560, projRadius: 5, projLife: 2.1
  },
  guerreiro: {
    r: 20, speed: 265, maxHp: 140,
    range: 180, dmg: 26, cdBase: 0.50,
    projSpeed: 880, projRadius: 6, projLife: 0.12,
    dashDist: 230, dashCd: 4.0, spinDur: 5.0, spinTick: 0.20, spinDmg: 7, spinRadiusExtra: 26
  },
  mago: {
    r: 18, speed: 210, maxHp: 95,
    range: 480, dmg: 22, cdBase: 0.95,
    projSpeed: 300, projRadius: 13, projLife: 2.8
  },
  assassino: {
    r: 17, speed: 310, maxHp: 80,
    range: 70, cdBase: 0.45,
    invisDur: 5.0, // aumentado de 3.0 para 5.0
    invisCd: 10.0
  },
  lorde: {
    r: 18, speed: 230, maxHp: 95,
    range: 460, cdBase: 0.0, // tiro padrão via drone
    drone: { fireCd: 0.12, dmg: 5, speed: 520, radius: 4 },
    formDur: 5.0, formSpeedBoost: 1.35
  },
  golem: {
    r: 26, speed: 150, maxHp: 300, // aumentado de 220
    range: 0, cdBase: 999, // sem auto-ataque
    rock: { dmg: 50, speed: 280, radius: 18, life: 3.0, cd: 3.5 } // dano 36 -> 50
  },
  dragonite: {
    r: 19, speed: 255, maxHp: 110,
    range: 420, dmg: 14, cdBase: 0.55,
    projSpeed: 420, projRadius: 6, projLife: 2.3,
    flame: { range: 120, tick: 0.15, dmg: 5 },
    berserk: { dur: 5.0, multSpeed: 1.35, multDmg: 1.9, multProjSpeed: 1.3, cd: 12.0 }
  }
};

// === Utils ===
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function len(x,y){ return Math.hypot(x,y); }

function circleRectResolve(px, py, pr, rect){
  const cx = clamp(px, rect.x, rect.x + rect.w);
  const cy = clamp(py, rect.y, rect.y + rect.h);
  const dx = px - cx, dy = py - cy;
  const d2 = dx*dx + dy*dy;
  if (d2 > pr*pr || (dx === 0 && dy === 0)) return { x: px, y: py };
  const d = Math.sqrt(d2) || 0.0001;
  const nx = dx / d, ny = dy / d;
  const overlap = pr - d + 0.01;
  return { x: px + nx*overlap, y: py + ny*overlap };
}

function resolveAgainstObstacles(px, py, r){
  let cx = px, cy = py;
  for (const ob of OBSTACLES) {
    const res = circleRectResolve(cx, cy, r, ob);
    cx = res.x; cy = res.y;
  }
  cx = clamp(cx, r, WORLD.w - r);
  cy = clamp(cy, r, WORLD.h - r);
  return { x: cx, y: cy };
}

function nearestEnemy(state, from, maxDist = Infinity) {
  let best = null, bestD = maxDist;
  for (const o of state.players.values()) {
    if (o.id === from.id) continue;
    const d = len(o.x - from.x, o.y - from.y);
    if (d < bestD) { best = o; bestD = d; }
  }
  return best ? { target: best, dist: bestD } : { target: null, dist: Infinity };
}

// === Estado por sala ===
const rooms = new Map();
function getRoom(code='arena'){
  if (!rooms.has(code)) {
    rooms.set(code, {
      players: new Map(),
      projectiles: [],
      companions: [],
      pickups: [],            // quadrados verdes de cura total
      pickupIdSeq: 0,
      projIdSeq: 0,
      compIdSeq: 0,
    });
  }
  return rooms.get(code);
}

function randomSpawn(m=120){
  return { x: Math.random()*(WORLD.w-m*2)+m, y: Math.random()*(WORLD.h-m*2)+m };
}

function ensureDrone(state, owner) {
  let d = state.companions.find(c => c.type==='drone' && c.ownerId===owner.id);
  if (!d) {
    d = { id: ++state.compIdSeq, type:'drone', ownerId: owner.id, x: owner.x+40, y: owner.y-40, ang: 0, dist: 46, fireCdLeft: 0 };
    state.companions.push(d);
  }
  return d;
}

function spawnPlayer(state, id, nickname, klass='arqueiro'){
  const cfg = CLASSES[klass] || CLASSES.arqueiro;
  const pos = randomSpawn();
  const p = {
    id, nickname: (nickname||'Soldado').slice(0,16), klass,
    x: pos.x, y: pos.y, r: cfg.r, speed: cfg.speed, hp: cfg.maxHp, maxHp: cfg.maxHp,
    range: cfg.range||0, dmg: cfg.dmg||0, cd: 0, cdBase: cfg.cdBase||0,
    projSpeed: cfg.projSpeed||0, projRadius: cfg.projRadius||0, projLife: cfg.projLife||0,
    dest: null, targetPlayerId: null,
    // status/skills
    dashCdLeft: 0, spinLeft: 0, spinTickLeft: 0, // guerreiro
    invisLeft: 0, invisCdLeft: 0,               // assassino
    droneFormLeft: 0,                            // lorde
    rockCdLeft: 0,                               // golem
    berserkLeft: 0, berserkCdLeft: 0             // dragonite
  };
  state.players.set(id, p);
  if (klass==='lorde') ensureDrone(state, p);
}

function respawnPlayer(state, p){
  const pos = randomSpawn();
  p.x=pos.x; p.y=pos.y; p.hp=p.maxHp;
  p.dest=null; p.targetPlayerId=null;
  p.spinLeft=0; p.spinTickLeft=0; p.dashCdLeft=0;
  p.invisLeft=0; p.droneFormLeft=0; p.rockCdLeft=0; p.berserkLeft=0;
}

function shoot(state, from, tx, ty){
  const ang = Math.atan2(ty - from.y, tx - from.x);
  const id = ++state.projIdSeq;
  state.projectiles.push({
    id,
    x: from.x + Math.cos(ang)*(from.r+6),
    y: from.y + Math.sin(ang)*(from.r+6),
    vx: Math.cos(ang)*(from.projSpeed||0),
    vy: Math.sin(ang)*(from.projSpeed||0),
    r: from.projRadius||5,
    ownerId: from.id,
    ownerClass: from.klass,
    dmg: from.dmg||0,
    life: from.projLife||1.5
  });
}

function makeProjectile(state, x, y, ang, speed, radius, life, ownerId, ownerClass, dmg){
  const id = ++state.projIdSeq;
  state.projectiles.push({ id, x: x + Math.cos(ang)*radius, y: y + Math.sin(ang)*radius, vx: Math.cos(ang)*speed, vy: Math.sin(ang)*speed, r: radius, ownerId, ownerClass, dmg, life });
}

function spawnHealPickup(state){
  const pos = randomSpawn(80);
  state.pickups.push({ id: ++state.pickupIdSeq, type:'heal', x: pos.x, y: pos.y, s: 22, ttl: 60 });
}

// === Loop ===
setInterval(() => {
  for (const [code, state] of rooms) {

    // Spawn de pickups: manter até 4 ativos, chance por segundo ~15%
    if (state.pickups.length < 4) {
      if (Math.random() < 0.15 * DT) spawnHealPickup(state);
    }

    // Cooldowns / status
    for (const p of state.players.values()) {
      p.cd = Math.max(0, p.cd - DT);
      p.dashCdLeft = Math.max(0, p.dashCdLeft - DT);
      p.spinLeft = Math.max(0, p.spinLeft - DT);
      p.spinTickLeft = Math.max(0, p.spinTickLeft - DT);
      p.invisLeft = Math.max(0, p.invisLeft - DT);
      p.invisCdLeft = Math.max(0, (p.invisCdLeft||0) - DT);
      p.droneFormLeft = Math.max(0, p.droneFormLeft - DT);
      p.rockCdLeft = Math.max(0, p.rockCdLeft - DT);
      p.berserkLeft = Math.max(0, p.berserkLeft - DT);
      p.berserkCdLeft = Math.max(0, p.berserkCdLeft - DT);
    }

    // Companions (drones do lorde)
    for (const d of state.companions) {
      if (d.type !== 'drone') continue;
      const owner = state.players.get(d.ownerId); if (!owner) { d._dead=true; continue; }
      // órbita
      d.ang += 1.8*DT;
      d.x = owner.x + Math.cos(d.ang)*d.dist;
      d.y = owner.y + Math.sin(d.ang)*d.dist;

      // mira: prioriza alvo travado; senão, auto-alvo mais próximo do DRONE
      d.fireCdLeft = Math.max(0, d.fireCdLeft - DT);
      let chosen = null;
      if (owner.targetPlayerId && state.players.has(owner.targetPlayerId)) {
        chosen = state.players.get(owner.targetPlayerId);
      } else {
        let best=null, bestD=Infinity;
        for (const o of state.players.values()) {
          if (o.id === owner.id) continue;
          const dist = len(o.x - d.x, o.y - d.y);
          if (dist < bestD) { best=o; bestD=dist; }
        }
        chosen = best;
      }

      if (chosen && d.fireCdLeft === 0) {
        const K = CLASSES.lorde.drone;
        const ang = Math.atan2(chosen.y - d.y, chosen.x - d.x);
        makeProjectile(state, d.x, d.y, ang, K.speed, K.radius, 1.8, owner.id, 'lorde', K.dmg);
        d.fireCdLeft = K.fireCd;
      }
    }
    state.companions = state.companions.filter(c => !c._dead);

    // Jogadores: mover, ataques e habilidades
    for (const p of state.players.values()) {
      const cfg = CLASSES[p.klass] || {};

      const multSpd = p.berserkLeft>0 ? (cfg.berserk?.multSpeed||1) : 1;
      const multDmg = p.berserkLeft>0 ? (cfg.berserk?.multDmg||1) : 1;
      const multProj = p.berserkLeft>0 ? (cfg.berserk?.multProjSpeed||1) : 1;

      // mover
      if (p.dest) {
        const dx = p.dest.x - p.x, dy = p.dest.y - p.y;
        const dist = len(dx, dy);
        if (dist > 2) {
          const ux = dx / dist, uy = dy / dist;
          const nx = p.x + ux * (p.speed*multSpd) * DT;
          const ny = p.y + uy * (p.speed*multSpd) * DT;
          const res = resolveAgainstObstacles(nx, ny, p.r);
          p.x = res.x; p.y = res.y;
        } else p.dest = null;
      }

      // ===== Alvo e ataques =====
      let target = null;
      if (p.targetPlayerId && state.players.has(p.targetPlayerId)) {
        const tp = state.players.get(p.targetPlayerId);
        if (tp && tp.id !== p.id) target = tp; else p.targetPlayerId = null;
      }
      if (!target) {
        if (p.klass === 'assassino' || p.klass === 'guerreiro' || p.klass === 'dragonite') {
          const shortRange = p.klass === 'dragonite' ? (CLASSES.dragonite.flame?.range || 110) : p.range;
          const { target: near } = nearestEnemy(state, p, shortRange);
          if (near) target = near;
        }
      }

      if (target) {
        const d = len(target.x - p.x, target.y - p.y);

        if (p.klass === 'assassino') {
          if (d <= (CLASSES.assassino.range || 60) && p.cd === 0) {
            const dmg = clamp(p.hp, 10, 45);
            target.hp -= dmg;
            p.cd = CLASSES.assassino.cdBase;
          }
        }
        else if (p.klass === 'guerreiro') {
          if (d <= p.range && p.cd === 0) {
            shoot(state, p, target.x, target.y);
            p.cd = p.cdBase;
          }
        }
        else if (p.klass === 'dragonite') {
          const flameRange = CLASSES.dragonite.flame?.range || 110;
          if (d <= flameRange) {
            if (p.cd === 0) {
              target.hp -= (CLASSES.dragonite.flame?.dmg || 5);
              p.cd = CLASSES.dragonite.flame?.tick || 0.15;
            }
          } else if (p.targetPlayerId && d <= p.range && p.cd === 0) {
            const tmp = {
              ...p,
              dmg: Math.round((p.dmg||14)*multDmg),
              projSpeed: (p.projSpeed||420)*multProj,
              projRadius: p.projRadius||6,
              projLife: p.projLife||2.3
            };
            shoot(state, tmp, target.x, target.y);
            p.cd = p.cdBase;
          }
        }
        else if (p.klass === 'lorde') {
          if (p.droneFormLeft > 0 && p.targetPlayerId && p.cd === 0) {
            const K = CLASSES.lorde.drone;
            const ang = Math.atan2(target.y - p.y, target.x - p.x);
            makeProjectile(state, p.x, p.y, ang, K.speed, K.radius, 1.8, p.id, 'lorde', K.dmg);
            p.cd = K.fireCd;
          }
        }
        else {
          if (p.targetPlayerId && d <= p.range && p.cd === 0) {
            const tmp = { ...p, dmg: Math.round((p.dmg||16)*multDmg), projSpeed: (p.projSpeed||0)*multProj };
            shoot(state, tmp, target.x, target.y);
            p.cd = p.cdBase;
          }
        }
      }

      // Guerreiro: giro (AoE)
      if (p.klass==='guerreiro' && p.spinLeft>0 && p.spinTickLeft===0) {
        p.spinTickLeft = CLASSES.guerreiro.spinTick;
        const rad = p.r + CLASSES.guerreiro.spinRadiusExtra;
        for (const o of state.players.values()) {
          if (o.id===p.id) continue;
          if (len(o.x-p.x,o.y-p.y)<=rad+o.r) o.hp -= CLASSES.guerreiro.spinDmg;
        }
      }
    }

    // Pickups: colisão + reduzir TTL
    for (const pk of state.pickups) { pk.ttl -= DT; if (pk.ttl <= 0) pk._dead = true; }
    for (const pk of state.pickups) {
      if (pk._dead) continue;
      for (const p of state.players.values()) {
        const half = pk.s/2;
        if (Math.abs(p.x - pk.x) <= half + p.r && Math.abs(p.y - pk.y) <= half + p.r) {
          // cura total
          p.hp = p.maxHp;
          pk._dead = true;
          break;
        }
      }
    }
    state.pickups = state.pickups.filter(pk => !pk._dead);

    // Projetéis
    for (const pr of state.projectiles) {
      pr.life -= DT; pr.x += pr.vx*DT; pr.y += pr.vy*DT;
      if (pr.x<0 || pr.y<0 || pr.x>WORLD.w || pr.y>WORLD.h) { pr._dead=true; continue; }
      // Obstáculos
      if (!pr._dead) {
        for (const ob of OBSTACLES) {
          if (pr.x>=ob.x && pr.x<=ob.x+ob.w && pr.y>=ob.y && pr.y<=ob.y+ob.h) { pr._dead=true; break; }
        }
      }
      if (pr._dead) continue;
      // Hit em jogadores (assassino invisível não leva projéteis)
      for (const p of state.players.values()) {
        if (p.id===pr.ownerId) continue;
        if (p.invisLeft>0) continue;
        if (len(p.x-pr.x, p.y-pr.y) <= p.r + pr.r) { p.hp -= pr.dmg; pr._dead=true; break; }
      }
    }

    // Projétil x Projétil: flecha do arqueiro vs orbe do mago
    for (let i=0;i<state.projectiles.length;i++) {
      const a = state.projectiles[i]; if (a._dead) continue;
      for (let j=i+1;j<state.projectiles.length;j++){
        const b = state.projectiles[j]; if (b._dead) continue;
        const d = len(a.x-b.x,a.y-b.y);
        if (d <= a.r + b.r) {
          if (a.ownerClass==='arqueiro' && b.ownerClass==='mago') a._dead = true;
          else if (b.ownerClass==='arqueiro' && a.ownerClass==='mago') b._dead = true;
        }
      }
    }

    // Limpeza
    state.projectiles = state.projectiles.filter(pr => !pr._dead && pr.life>0);

    // Respawn
    for (const p of state.players.values()) if (p.hp<=0) respawnPlayer(state, p);

    // Snapshot
    const snap = {
      t: Date.now(), world: WORLD, obstacles: OBSTACLES,
      players: Array.from(state.players.values()).map(p => ({
        id:p.id,x:p.x,y:p.y,r:p.r,hp:p.hp,maxHp:p.maxHp,nickname:p.nickname,klass:p.klass,
        targetId:p.targetPlayerId,spinLeft:p.spinLeft,invisLeft:p.invisLeft,droneFormLeft:p.droneFormLeft,berserkLeft:p.berserkLeft,
        dashCdLeft:p.dashCdLeft,invisCdLeft:p.invisCdLeft,rockCdLeft:p.rockCdLeft,berserkCdLeft:p.berserkCdLeft
      })),
      projectiles: state.projectiles.map(pr => ({ id:pr.id,x:pr.x,y:pr.y,r:pr.r,ownerId:pr.ownerId,ownerClass:pr.ownerClass })),
      companions: state.companions.map(c => ({ id:c.id,type:c.type,ownerId:c.ownerId,x:c.x,y:c.y })),
      pickups: state.pickups.map(pk => ({ id:pk.id,type:pk.type,x:pk.x,y:pk.y,s:pk.s }))
    };
    io.to(code).emit('state', snap);
  }
}, 1000 / TICK_RATE);

// === HTTP estático ===
app.use(express.static('public'));

// === Sockets ===
io.on('connection', (socket)=>{
  let room = 'arena';

  socket.on('join', ({ roomCode, nickname, klass }) => {
    room = (roomCode||'arena').toLowerCase();
    socket.join(room);
    const state = getRoom(room);
    spawnPlayer(state, socket.id, nickname, (klass||'arqueiro'));
  });

  socket.on('pointer', ({ x, y }) => {
    const state = getRoom(room);
    const p = state.players.get(socket.id); if (!p) return;
    // clique em outro player = trava alvo; senão, move
    let hit=null; for (const o of state.players.values()) {
      if (o.id===p.id) continue;
      const d = len(o.x-x,o.y-y);
      if (d <= o.r + 10) { hit=o; break; }
    }
    if (hit) { p.targetPlayerId = hit.id; p.dest = null; }
    else { p.dest = { x, y }; p.targetPlayerId = null; }
  });

  // Habilidades por double tap
  socket.on('ability', ({ tx, ty }) => {
    const state = getRoom(room);
    const p = state.players.get(socket.id); if (!p) return;
    const cfg = CLASSES[p.klass]||{};

    if (p.klass==='guerreiro') {
      if (p.dashCdLeft>0) return;
      const ang=Math.atan2(ty-p.y, tx-p.x);
      const nx=p.x+Math.cos(ang)*(cfg.dashDist||200);
      const ny=p.y+Math.sin(ang)*(cfg.dashDist||200);
      const res=resolveAgainstObstacles(nx,ny,p.r);
      p.x=res.x; p.y=res.y;
      p.dashCdLeft=cfg.dashCd||4;
      p.spinLeft=cfg.spinDur||5;
      p.spinTickLeft=0;
    }
    else if (p.klass==='assassino') {
      if ((p.invisCdLeft||0)>0) return;
      p.invisLeft = cfg.invisDur||5.0;
      p.invisCdLeft = cfg.invisCd||10;
    }
    else if (p.klass==='lorde') {
      p.droneFormLeft = CLASSES.lorde.formDur;
      ensureDrone(state, p);
    }
    else if (p.klass==='golem') {
      if (p.rockCdLeft>0) return;
      const ang=Math.atan2(ty-p.y, tx-p.x);
      const K=cfg.rock;
      makeProjectile(state, p.x, p.y, ang, K.speed, K.radius, K.life, p.id, 'golem', K.dmg);
      p.rockCdLeft=K.cd;
    }
    else if (p.klass==='dragonite') {
      if ((p.berserkCdLeft||0)>0) return;
      p.berserkLeft = cfg.berserk.dur;
      p.berserkCdLeft = cfg.berserk.cd;
    }
  });

  socket.on('respawn', ()=>{
    const state=getRoom(room);
    const p=state.players.get(socket.id);
    if(!p) return;
    respawnPlayer(state,p);
  });

  socket.on('changeNick', (nick)=>{
    const state=getRoom(room);
    const p=state.players.get(socket.id);
    if(!p) return;
    p.nickname=(nick||'Soldado').slice(0,16);
  });

  socket.on('disconnect', ()=>{
    const state=getRoom(room);
    state.players.delete(socket.id);
    state.companions = state.companions.filter(c => c.ownerId!==socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor no ar na porta ' + PORT));
