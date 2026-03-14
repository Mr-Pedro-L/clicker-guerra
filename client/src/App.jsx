import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

// Cliente: adiciona
// - Rosa dos ventos/zonas de referência no mapa (rótulos N/NE/L/SE/S/SO/O/NO + rosa no HUD)
// - HUD de timers de habilidades (ativações e cooldowns)
// - Render dos pickups verdes (cura total)

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

export default function App() {
  const canvasRef = useRef(null);
  const [ui, setUi] = useState({ started: false, nickname: "", klass: "arqueiro" });
  const [hud, setHud] = useState({ hp: 100, players: 1, nickname: "" });
  const socketRef = useRef(null);
  const myIdRef = useRef(null);
  const snapRef = useRef({ world: { w: 2800, h: 1800 }, obstacles: [], players: [], projectiles: [], companions: [], pickups: [] });

  // números de dano
  const floatsRef = useRef([]);
  const lastHpRef = useRef(new Map());
  const shakeRef = useRef({ t: 0, mag: 0 });

  const lastTapRef = useRef({ t: 0, x: 0, y: 0 });

  useEffect(() => {
    if (!ui.started) return;

    const socket = io(SERVER_URL, { transports: ["websocket"], autoConnect: true });
    socketRef.current = socket;

    socket.on("connect", () => { myIdRef.current = socket.id; });
    socket.emit("join", { roomCode: "arena", nickname: ui.nickname || "Soldado", klass: ui.klass });

    socket.on("state", (s) => { snapRef.current = s; });

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { alpha: false });

    let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    function resize() {
      dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const w = Math.floor(window.innerWidth);
      const h = Math.floor(window.innerHeight);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const cam = { x: 0, y: 0 };
    function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
    function updateCamera(me, world, viewW, viewH) {
      if (!me) return;
      cam.x = clamp(me.x - viewW / 2, 0, Math.max(0, world.w - viewW));
      cam.y = clamp(me.y - viewH / 2, 0, Math.max(0, world.h - viewH));
    }

    function toWorldPos(evt) {
      const rect = canvas.getBoundingClientRect();
      const cx = evt.clientX - rect.left;
      const cy = evt.clientY - rect.top;
      return { x: cx + cam.x, y: cy + cam.y };
    }

    const onPointerDown = (e) => {
      e.preventDefault();
      const p = toWorldPos(e);

      const now = performance.now();
      const last = lastTapRef.current;
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      if (now - last.t <= 280 && dist <= 20) {
        socket.emit("ability", { tx: p.x, ty: p.y });
        lastTapRef.current = { t: 0, x: 0, y: 0 };
      } else {
        lastTapRef.current = { t: now, x: p.x, y: p.y };
        socket.emit("pointer", { x: p.x, y: p.y });
      }
    };
    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });

    let last = performance.now();
    let running = true;

    function step(now) {
      if (!running) return;
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;

      const snap = snapRef.current;
      const viewW = canvas.width / dpr; const viewH = canvas.height / dpr;
      const me = snap.players.find(p => p.id === myIdRef.current) || null;
      updateCamera(me, snap.world, viewW, viewH);

      // feedback de dano
      for (const p of snap.players) {
        const prev = lastHpRef.current.get(p.id) ?? p.hp;
        if (p.hp < prev) {
          floatsRef.current.push({ x: p.x, y: p.y - p.r - 18, text: `-${prev - p.hp}`, life: 0.9 });
          if (p.id === myIdRef.current) { shakeRef.current = { t: 0.20, mag: 6 }; navigator.vibrate?.(15); }
        }
        lastHpRef.current.set(p.id, p.hp);
      }
      for (const f of floatsRef.current) { f.life -= dt; f.y -= 20 * dt; }
      floatsRef.current = floatsRef.current.filter(f => f.life > 0);

      let shakeX = 0, shakeY = 0;
      if (shakeRef.current.t > 0) {
        shakeRef.current.t -= dt; const k = shakeRef.current.mag * (shakeRef.current.t / 0.20);
        shakeX = (Math.random() - 0.5) * k; shakeY = (Math.random() - 0.5) * k;
      }

      // fundo
      ctx.fillStyle = "#0b0f1a"; ctx.fillRect(0, 0, viewW, viewH);

      // grid
      ctx.strokeStyle = "#0f1628"; ctx.lineWidth = 1; const grid = 64;
      const x0 = -((cam.x % grid) + grid) % grid; const y0 = -((cam.y % grid) + grid) % grid;
      for (let x = x0; x < viewW; x += grid) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, viewH); ctx.stroke(); }
      for (let y = y0; y < viewH; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(viewW, y); ctx.stroke(); }

      // borda do mundo
      ctx.strokeStyle = "#1b2440"; ctx.lineWidth = 4;
      ctx.strokeRect(-cam.x + shakeX, -cam.y + shakeY, snap.world.w, snap.world.h);

      // zonas / labels no mapa (rosa dos ventos grande)
      drawZoneLabels(ctx, snap.world, cam, viewW, viewH, shakeX, shakeY);

      // obstáculos
      for (const ob of snap.obstacles) {
        ctx.fillStyle = "#1f2a44";
        ctx.fillRect(ob.x - cam.x + shakeX, ob.y - cam.y + shakeY, ob.w, ob.h);
        ctx.strokeStyle = "#2a3b66"; ctx.lineWidth = 2;
        ctx.strokeRect(ob.x - cam.x + 0.5 + shakeX, ob.y - cam.y + 0.5 + shakeY, ob.w - 1, ob.h - 1);
      }

      // pickups (cura total)
      for (const pk of snap.pickups || []) {
        ctx.fillStyle = '#2ecc71';
        ctx.fillRect(pk.x - cam.x - pk.s/2 + shakeX, pk.y - cam.y - pk.s/2 + shakeY, pk.s, pk.s);
        ctx.strokeStyle = '#27ae60'; ctx.lineWidth = 2;
        ctx.strokeRect(pk.x - cam.x - pk.s/2 + shakeX+0.5, pk.y - cam.y - pk.s/2 + shakeY+0.5, pk.s-1, pk.s-1);
        // cruz branca
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(pk.x - cam.x + shakeX, pk.y - cam.y - pk.s/2 + 4 + shakeY); ctx.lineTo(pk.x - cam.x + shakeX, pk.y - cam.y + pk.s/2 - 4 + shakeY); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pk.x - cam.x - pk.s/2 + 4 + shakeX, pk.y - cam.y + shakeY); ctx.lineTo(pk.x - cam.x + pk.s/2 - 4 + shakeX, pk.y - cam.y + shakeY); ctx.stroke();
      }

      // projéteis
      const klassById = new Map(snap.players.map(p => [p.id, p.klass]));
      for (const pr of snap.projectiles) {
        const klass = pr.ownerClass || klassById.get(pr.ownerId);
        ctx.beginPath();
        if (klass === 'mago') ctx.fillStyle = '#ff4d4d';
        else if (pr.ownerId === myIdRef.current) ctx.fillStyle = '#66e0ff';
        else ctx.fillStyle = '#ff7fb0';
        ctx.arc(pr.x - cam.x + shakeX, pr.y - cam.y + shakeY, pr.r, 0, Math.PI*2); ctx.fill();
      }

      // companions (drones)
      for (const c of snap.companions||[]) {
        if (c.type !== 'drone') continue;
        drawTriangle(ctx, c.x - cam.x + shakeX, c.y - cam.y + shakeY, 10, '#9be7ff');
      }

      // players
      for (const p of snap.players) {
        const isMe = p.id === myIdRef.current;
        const base = isMe ? "#4da3ff" : "#7fb5ff";
        const alpha = (p.invisLeft||0) > 0 ? 0.35 : 1;

        // sombra
        ctx.globalAlpha = alpha * 1; ctx.beginPath(); ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.arc(p.x - cam.x + 2 + shakeX, p.y - cam.y + 3 + shakeY, p.r, 0, Math.PI * 2); ctx.fill();

        // corpo
        const prev = lastHpRef.current.get(p.id) ?? p.hp; const flash = (prev > p.hp) ? 1 : 0;
        ctx.beginPath(); ctx.fillStyle = flash ? "#ffffff" : base; ctx.globalAlpha = alpha;
        ctx.arc(p.x - cam.x + shakeX, p.y - cam.y + shakeY, p.r, 0, Math.PI*2); ctx.fill(); ctx.globalAlpha = 1;

        // chapéus/adereços
        drawHeadgear(ctx, p, cam, shakeX, shakeY);

        // anel de giro (guerreiro)
        if (p.klass==='guerreiro' && (p.spinLeft||0)>0) {
          ctx.strokeStyle='rgba(255,255,255,0.35)'; ctx.lineWidth=2; ctx.setLineDash([8,6]);
          ctx.beginPath(); ctx.arc(p.x - cam.x + shakeX, p.y - cam.y + shakeY, p.r + 26, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
        }

        // hp e nome
        drawHpBar(ctx, p.x - cam.x + shakeX, p.y - cam.y - p.r - 12 + shakeY, 56, 8, p.hp / p.maxHp);
        ctx.fillStyle = "#d9ecff"; ctx.font = "bold 13px system-ui, Arial"; ctx.textAlign = "center";
        ctx.fillText(p.nickname || "Soldado", p.x - cam.x + shakeX, p.y - cam.y - p.r - 22 + shakeY);
      }

      // indicador de alvo travado (para mim)
      if (me && me.targetId) {
        const tgt = snap.players.find(p => p.id === me.targetId);
        if (tgt) {
          ctx.strokeStyle = '#ffdd57'; ctx.lineWidth = 3; ctx.setLineDash([6,6]);
          ctx.beginPath(); ctx.arc(tgt.x - cam.x + shakeX, tgt.y - cam.y + shakeY, tgt.r + 10, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
          ctx.strokeStyle = 'rgba(255,221,87,0.5)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(me.x - cam.x + shakeX, me.y - cam.y + shakeY); ctx.lineTo(tgt.x - cam.x + shakeX, tgt.y - cam.y + shakeY); ctx.stroke();
        }
      }

      // números flutuantes
      for (const f of floatsRef.current) {
        ctx.globalAlpha = Math.max(0, f.life);
        ctx.fillStyle = '#ff6b6b'; ctx.font = 'bold 14px system-ui, Arial'; ctx.textAlign = 'center';
        ctx.fillText(f.text, f.x - cam.x + shakeX, f.y - cam.y + shakeY);
        ctx.globalAlpha = 1;
      }

      // HUD básicos
      const myHp = me?.hp ?? 100;
      setHud({ hp: myHp, players: snap.players.length, nickname: me?.nickname || ui.nickname || 'Soldado' });

      // Rosa dos ventos (HUD mini) + timers
      drawCompassHUD(ctx);
      if (me) drawAbilityHUD(ctx, me, ui.klass);

      requestAnimationFrame(step);
    }

    const raf = requestAnimationFrame(step);

    return () => {
      socket.disconnect(); cancelAnimationFrame(raf); canvas.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("resize", resize);
    };
  }, [ui.started]);

  // ===== helpers de desenho =====
  function drawHpBar(ctx, x, y, w, h, pct) {
    ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(x - w/2, y, w, h);
    ctx.fillStyle = pct > 0.5 ? "#7CFC7C" : pct > 0.2 ? "#ffd166" : "#ff6b6b";
    ctx.fillRect(x - w/2, y, Math.max(0, w * pct), h);
  }

  function drawTriangle(ctx, x, y, r, color) { ctx.fillStyle=color; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x - r*0.9, y + r*0.8); ctx.lineTo(x + r*0.9, y + r*0.8); ctx.closePath(); ctx.fill(); }

  function drawHeadgear(ctx, p, cam, sx=0, sy=0) {
    const x = p.x - cam.x + sx, y = p.y - cam.y + sy, r = p.r;
    ctx.save();
    if (p.klass === 'arqueiro') {
      ctx.fillStyle = '#2ecc71'; ctx.beginPath(); ctx.moveTo(x - r * 0.9, y - r * 1.15); ctx.lineTo(x + r * 0.6, y - r * 1.6); ctx.lineTo(x + r * 0.9, y - r * 1.0); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#27ae60'; ctx.lineWidth = 2; ctx.stroke(); ctx.strokeStyle = '#27ae60'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - r*0.8, y - r*0.9); ctx.lineTo(x + r*0.9, y - r*0.9); ctx.stroke();
    } else if (p.klass === 'guerreiro') {
      ctx.fillStyle = '#bdc3c7'; ctx.beginPath(); ctx.arc(x, y - r*0.9, r*0.95, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#95a5a6'; ctx.fillRect(x - r*0.9, y - r*0.9, r*1.8, 4);
    } else if (p.klass === 'mago') {
      ctx.fillStyle = '#8e44ad'; ctx.beginPath(); ctx.moveTo(x, y - r * 2.0); ctx.lineTo(x - r * 0.9, y - r * 0.8); ctx.lineTo(x + r * 0.9, y - r * 0.8); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#6c3483'; ctx.fillRect(x - r*1.0, y - r*0.8, r*2.0, 4);
    } else if (p.klass === 'assassino') {
      ctx.fillStyle = '#2c3e50'; ctx.beginPath(); ctx.moveTo(x - r*1.0, y - r*0.6); ctx.lineTo(x, y - r*1.6); ctx.lineTo(x + r*1.0, y - r*0.6); ctx.closePath(); ctx.fill();
    } else if (p.klass === 'lorde') {
      ctx.fillStyle = '#00e5ff'; ctx.fillRect(x - r*0.7, y - r*0.9, r*1.4, 6);
    } else if (p.klass === 'golem') {
      ctx.strokeStyle = '#7f8c8d'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.stroke();
    } else if (p.klass === 'dragonite') {
      ctx.fillStyle = '#f5b041'; ctx.beginPath(); ctx.moveTo(x - r*1.6, y); ctx.lineTo(x - r*0.2, y - r*0.6); ctx.lineTo(x - r*0.2, y + r*0.4); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x + r*1.6, y); ctx.lineTo(x + r*0.2, y - r*0.6); ctx.lineTo(x + r*0.2, y + r*0.4); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function drawCompassHUD(ctx) {
    const x = 64, y = 64, r = 26;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('N', 0, -r-6); ctx.fillText('S', 0, r+12); ctx.fillText('O', -r-10, 4); ctx.fillText('L', r+10, 4);
    ctx.restore();
  }

  function drawZoneLabels(ctx, world, cam, viewW, viewH, sx, sy) {
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 160px system-ui'; ctx.textAlign = 'center';
    const centers = [
      { t: 'N', x: world.w/2, y: world.h*0.20 },
      { t: 'S', x: world.w/2, y: world.h*0.80 },
      { t: 'O', x: world.w*0.20, y: world.h/2 },
      { t: 'L', x: world.w*0.80, y: world.h/2 },
      { t: 'NE', x: world.w*0.80, y: world.h*0.20 },
      { t: 'NO', x: world.w*0.20, y: world.h*0.20 },
      { t: 'SE', x: world.w*0.80, y: world.h*0.80 },
      { t: 'SO', x: world.w*0.20, y: world.h*0.80 },
    ];
    for (const c of centers) {
      const vx = c.x - cam.x + sx, vy = c.y - cam.y + sy;
      if (vx >= -200 && vy >= -200 && vx <= viewW+200 && vy <= viewH+200) {
        ctx.fillText(c.t, vx, vy);
      }
    }
    ctx.restore();
  }

  function drawAbilityHUD(ctx, me, myClass) {
    // Caixa no canto superior direito
    const pad = 12; const boxW = 230; const boxH = 108;
    const x = (canvasRef.current.width / Math.max(1, Math.min(2, window.devicePixelRatio||1))) - boxW - pad;
    const y = pad;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x, y, boxW, boxH);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.strokeRect(x+0.5, y+0.5, boxW-1, boxH-1);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 13px system-ui'; ctx.fillText('Habilidades', x+10, y+18);

    // Helper para linha
    function line(label, activeLeft, cdLeft, row){
      const ly = y + 18 + row*22;
      ctx.fillStyle = '#cfd8dc'; ctx.font = '12px system-ui'; ctx.fillText(label, x+10, ly+16);
      const w=120, h=8; const bx=x+100, by=ly+8;
      ctx.fillStyle='rgba(255,255,255,0.15)'; ctx.fillRect(bx, by, w, h);
      let pct=0; let txt='';
      if (activeLeft && activeLeft>0) { pct = Math.min(1, activeLeft / 5); txt = activeLeft.toFixed(1)+'s'; ctx.fillStyle='#7CFC7C'; }
      else if (cdLeft && cdLeft>0) { // barra de cooldown invertida
        pct = 1 - Math.max(0, Math.min(1, cdLeft / 10)); ctx.fillStyle='#ffd166'; txt = (cdLeft).toFixed(1)+'s';
      } else { pct = 1; ctx.fillStyle='#66e0ff'; txt='Pronto'; }
      ctx.fillRect(bx, by, w*pct, h);
      ctx.fillStyle='#ffffff'; ctx.font='10px system-ui'; ctx.textAlign='center'; ctx.fillText(txt, bx+w/2, by+h+11);
      ctx.textAlign='start';
    }

    // Mostrar linhas conforme classe
    if (myClass==='guerreiro') {
      line('Dash', 0, me.dashCdLeft, 1);
      line('Giro', me.spinLeft, 0, 2);
    } else if (myClass==='assassino') {
      line('Invisível', me.invisLeft, me.invisCdLeft, 1);
    } else if (myClass==='lorde') {
      line('Forma Drone', me.droneFormLeft, 0, 1);
    } else if (myClass==='golem') {
      line('Rocha', 0, me.rockCdLeft, 1);
    } else if (myClass==='dragonite') {
      line('Berserk', me.berserkLeft, me.berserkCdLeft, 1);
    }

    ctx.restore();
  }

  const handleStart = () => {
    if (!(ui.nickname || '').trim()) { alert('Digite um nickname'); return; }
    setUi(s => ({ ...s, started: true }));
  };

  const handleRespawn = () => socketRef.current?.emit("respawn");

  return (
    <div className="relative w-screen h-[100svh] bg-black select-none overflow-hidden">
      <canvas ref={canvasRef} className="block w-full h-full touch-none" style={{ touchAction: 'none' }} />

      {/* HUD */}
      {ui.started && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-2xl bg-black/40 px-3 py-2 text-white shadow-md">
          <div className="text-sm">HP: <b>{Math.max(0, Math.floor(hud.hp))}</b> • Jogadores: <b>{hud.players}</b></div>
          <div className="text-xs opacity-80">Você: {hud.nickname || ui.nickname}</div>
        </div>
      )}

      {/* Respawn */}
      {ui.started && (
        <div className="absolute right-3 bottom-3 z-10">
          <button onClick={handleRespawn} className="rounded-2xl bg-blue-500 px-4 py-2 text-white shadow-lg active:scale-95">Respawn</button>
        </div>
      )}

      {/* Tela inicial */}
      {!ui.started && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-slate-900 p-4 text-white shadow-xl">
            <h1 className="mb-2 text-xl font-semibold">Clicker de Guerra — PvP</h1>
            <p className="mb-3 text-sm opacity-80">Escolha sua classe, digite o nickname e toque em começar.</p>

            <label className="block text-sm mb-2">Nickname</label>
            <input
              value={ui.nickname}
              onChange={(e) => setUi(s => ({ ...s, nickname: e.target.value }))}
              maxLength={16}
              placeholder="Seu nickname"
              className="mb-3 w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
            />

            <label className="block text-sm mb-2">Classe</label>
            <div className="mb-4 grid grid-cols-2 gap-2">
              {['arqueiro','guerreiro','mago','assassino','lorde','golem','dragonite'].map(k => (
                <button key={k}
                  className={`rounded-xl px-3 py-2 ${ui.klass===k?'bg-blue-600':'bg-slate-700'}`}
                  onClick={() => setUi(s => ({ ...s, klass: k }))}
                >{k}</button>
              ))}
            </div>

            <button onClick={handleStart} className="w-full rounded-xl bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 active:scale-95">Começar</button>
            <p className="mt-3 text-xs opacity-70">Controles: Toque para mover • Toque em um jogador para focar • Double tap = habilidade da classe</p>
            <p className="mt-1 text-xs opacity-70">Servidor: <span className="opacity-90">{SERVER_URL}</span></p>
          </div>
        </div>
      )}
    </div>
  );
}
