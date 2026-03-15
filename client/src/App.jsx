import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

// App.jsx (textured):
// - Campo de batalha VERDE (planície) com textura procedural (tile) e rosa dos ventos
// - Obstáculos desenhados como PEDRAS texturizadas (em vez de blocos lisos)
// - Personagens com rosto e braços + acessórios por classe (mago=cajado, arqueiro=arco, guerreiro=espada, assassino=adagas, lorde=óculos, golem=rachaduras, dragonite=asas)
// - HUD de habilidades mantido
// - Interpolação de snapshots para movimento SUAVE (SNAP_DELAY_MS)
// - Tela inicial animada (fundo dinâmico) e botões com estados (hover/selecionado)

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
const SNAP_DELAY_MS = 100; // atraso visual p/ interpolação

export default function App(){
  const canvasRef = useRef(null);
  const bgRef = useRef(null); // fundo animado da tela inicial
  const [ui, setUi] = useState({ started:false, nickname:"", klass:"arqueiro" });
  const [hud, setHud] = useState({ hp:100, players:1, nickname:"" });
  const socketRef = useRef(null);
  const myIdRef = useRef(null);

  // fila de snapshots (interpolação)
  const snapsQueueRef = useRef([]);
  const latestRef = useRef({ world:{w:2800,h:1800}, obstacles:[], players:[], projectiles:[], companions:[], pickups:[], t:Date.now() });

  // efeitos
  const floatsRef = useRef([]);
  const lastHpRef = useRef(new Map());
  const shakeRef = useRef({ t:0, mag:0 });
  const lastTapRef = useRef({ t:0, x:0, y:0 });

  // textura de grama (planície)
  const grassTileRef = useRef(null); // offscreen canvas tile 128x128

  useEffect(()=>{
    if (!ui.started) return;

    const socket = io(SERVER_URL, { transports:["websocket"], autoConnect:true });
    socketRef.current = socket;
    socket.on('connect', ()=>{ myIdRef.current = socket.id; });
    socket.emit('join', { roomCode:'arena', nickname: ui.nickname || 'Soldado', klass: ui.klass });

    socket.on('state', (s)=>{
      const t = s.t || Date.now();
      const snap = { ...s, t };
      snapsQueueRef.current.push(snap);
      latestRef.current = snap;
      const cutoff = t - 1500;
      while (snapsQueueRef.current.length && snapsQueueRef.current[0].t < cutoff) snapsQueueRef.current.shift();
    });

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha:false });

    // DPR e resize
    let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    function resize(){
      dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const w = Math.floor(window.innerWidth), h = Math.floor(window.innerHeight);
      canvas.width = Math.floor(w*dpr); canvas.height = Math.floor(h*dpr);
      canvas.style.width = w+'px'; canvas.style.height = h+'px';
      ctx.setTransform(dpr,0,0,dpr,0,0);
    }
    resize();
    window.addEventListener('resize', resize);

    // impedir rolagem
    const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';

    // câmera
    const cam = { x:0, y:0 };
    const clamp = (v,a,b)=> Math.max(a, Math.min(b,v));
    function updateCamera(me, world, vw, vh){ if(!me) return; cam.x = clamp(me.x - vw/2, 0, Math.max(0, world.w - vw)); cam.y = clamp(me.y - vh/2, 0, Math.max(0, world.h - vh)); }

    // ===== Textura de GRAMA (tile 128x128 procedural) =====
    function buildGrassTile(){
      const ts = 128; const off = document.createElement('canvas'); off.width = off.height = ts; const g = off.getContext('2d');
      // base
      g.fillStyle = '#1d4020'; g.fillRect(0,0,ts,ts);
      // variações (manchas)
      for(let i=0;i<90;i++){ const r= Math.random()*10+6; const x=Math.random()*ts, y=Math.random()*ts; g.fillStyle = `rgba(40,90,42,${Math.random()*0.15+0.05})`; g.beginPath(); g.arc(x,y,r,0,Math.PI*2); g.fill(); }
      // "fios" de grama
      g.strokeStyle = 'rgba(120,180,110,0.25)'; g.lineWidth = 1;
      for(let i=0;i<60;i++){ const x=Math.random()*ts, y=Math.random()*ts; const len=3+Math.random()*6; const ang=Math.random()*Math.PI*2; g.beginPath(); g.moveTo(x,y); g.lineTo(x+Math.cos(ang)*len, y+Math.sin(ang)*len); g.stroke(); }
      grassTileRef.current = off;
    }
    buildGrassTile();

    // ===== Interpolação =====
    function getInterpolatedPlayer(id, now){
      const q = snapsQueueRef.current; if (q.length<2) { const L = q[q.length-1] || latestRef.current; return (L.players||[]).find(p=>p.id===id)||null; }
      const rt = now - SNAP_DELAY_MS; let a=null,b=null;
      for(let i=q.length-1;i>=0;i--){ if(q[i].t<=rt){ a=q[i]; b=q[i+1]||q[i]; break; } }
      if(!a){ a=q[0]; b=q[1]||q[0]; } if(!b) b=a;
      const pa=a.players.find(p=>p.id===id), pb=b.players.find(p=>p.id===id);
      if(!pa && !pb) return null; const ax=pa?pa.x:(pb?pb.x:0), ay=pa?pa.y:(pb?pb.y:0); const bx=pb?pb.x:ax, by=pb?pb.y:ay;
      const span=Math.max(1,b.t-a.t), alpha=Math.max(0,Math.min(1,(rt-a.t)/span));
      return { x: ax+(bx-ax)*alpha, y: ay+(by-ay)*alpha, r:(pb?.r??pa?.r??18), hp:(pb?.hp??pa?.hp??100), maxHp:(pb?.maxHp??pa?.maxHp??100), nickname:(pb?.nickname??pa?.nickname??'Soldado'), klass:(pb?.klass??pa?.klass??'arqueiro'), targetId:(pb?.targetId??pa?.targetId??null), spinLeft:(pb?.spinLeft??pa?.spinLeft??0), invisLeft:(pb?.invisLeft??pa?.invisLeft??0), droneFormLeft:(pb?.droneFormLeft??pa?.droneFormLeft??0), berserkLeft:(pb?.berserkLeft??pa?.berserkLeft??0) };
    }

    // input (clique move / clica em player trava alvo / double tap = habilidade)
    function toWorldPos(evt){ const r=canvas.getBoundingClientRect(); const cx=evt.clientX-r.left, cy=evt.clientY-r.top; return { x: cx+cam.x, y: cy+cam.y }; }
    const onPointerDown = (e)=>{ e.preventDefault(); const p=toWorldPos(e); const now=performance.now(); const last=lastTapRef.current; const dist=Math.hypot(p.x-last.x,p.y-last.y);
      if(now-last.t<=280 && dist<=20){ socket.emit('ability',{tx:p.x,ty:p.y}); lastTapRef.current={t:0,x:0,y:0}; }
      else { lastTapRef.current={t:now,x:p.x,y:p.y}; socket.emit('pointer',{x:p.x,y:p.y}); }
    };
    canvas.addEventListener('pointerdown', onPointerDown, { passive:false });

    // ===== Desenho =====
    const drawGrass = (ctx, vw, vh)=>{
      const tile = grassTileRef.current; if(!tile) return;
      const ts = tile.width; // 128
      // começo dos tiles visíveis
      const x0 = -((cam.x % ts) + ts) % ts; const y0 = -((cam.y % ts)+ ts) % ts;
      for(let x=x0; x<vw; x+=ts){ for(let y=y0; y<vh; y+=ts){ ctx.drawImage(tile, x, y); } }
    };

    const drawStoneRect = (ctx, x,y,w,h)=>{
      // pedra arredondada estilizada dentro do retângulo do servidor
      const rx = 16, ry = 16; const r=8;
      ctx.save();
      ctx.translate(x,y);
      // forma
      ctx.beginPath();
      ctx.moveTo(r,0); ctx.lineTo(w-r,0); ctx.quadraticCurveTo(w,0,w,r);
      ctx.lineTo(w,h-r); ctx.quadraticCurveTo(w,h,w-r,h);
      ctx.lineTo(r,h); ctx.quadraticCurveTo(0,h,0,h-r);
      ctx.lineTo(0,r); ctx.quadraticCurveTo(0,0,r,0);
      // textura base
      const grd = ctx.createLinearGradient(0,0,w,h);
      grd.addColorStop(0,'#6e767d'); grd.addColorStop(1,'#3f464c');
      ctx.fillStyle = grd; ctx.fill();
      ctx.strokeStyle = '#2c3136'; ctx.lineWidth = 2; ctx.stroke();
      // rachaduras leves
      ctx.strokeStyle = 'rgba(20,20,20,0.35)'; ctx.lineWidth=1;
      for(let i=0;i<5;i++){
        const sx = Math.random()*w*0.8 + w*0.1; const sy = Math.random()*h*0.8 + h*0.1; const len = 20+Math.random()*40; const ang = Math.random()*Math.PI*2;
        ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(sx+Math.cos(ang)*len, sy+Math.sin(ang)*len); ctx.stroke();
      }
      ctx.restore();
    };

    function drawHpBar(ctx,x,y,w,h,pct){ ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fillRect(x-w/2,y,w,h); ctx.fillStyle = pct>0.5? '#7CFC7C' : pct>0.2? '#ffd166' : '#ff6b6b'; ctx.fillRect(x-w/2,y, Math.max(0,w*pct), h); }

    function drawFaceAndArms(ctx, px, py, r){
      // braços
      ctx.strokeStyle = 'rgba(230,230,230,0.85)'; ctx.lineWidth = 3; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(px - r*0.7, py + r*0.1); ctx.lineTo(px - r*1.2, py + r*0.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px + r*0.7, py + r*0.1); ctx.lineTo(px + r*1.2, py + r*0.4); ctx.stroke();
      // rosto (olhos)
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(px - r*0.35, py - r*0.2, 2, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(px + r*0.35, py - r*0.2, 2, 0, Math.PI*2); ctx.fill();
    }

    function drawAccessory(ctx, p, px, py, baseColor){
      ctx.save();
      if(p.klass==='mago'){
        // cajado (madeira + esfera mágica)
        ctx.strokeStyle = '#7b4a20'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(px+p.r*0.9, py); ctx.lineTo(px+p.r*1.4, py-p.r*0.6); ctx.stroke();
        ctx.fillStyle = 'rgba(170,120,255,0.8)'; ctx.beginPath(); ctx.arc(px+p.r*1.45, py-p.r*0.65, 6, 0, Math.PI*2); ctx.fill();
      } else if(p.klass==='guerreiro'){
        // espada
        ctx.strokeStyle = '#cfd8dc'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(px+p.r*0.2, py-p.r*1.1); ctx.lineTo(px+p.r*1.1, py-p.r*1.6); ctx.stroke();
        ctx.strokeStyle = '#b38b00'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(px+p.r*0.15, py-p.r*1.05); ctx.lineTo(px+p.r*0.35, py-p.r*1.2); ctx.stroke();
      } else if(p.klass==='arqueiro'){
        // arco
        ctx.strokeStyle = '#a6753a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(px+p.r*0.9, py, p.r*0.9, -Math.PI/3, Math.PI/3); ctx.stroke();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px+p.r*0.05, py); ctx.lineTo(px+p.r*1.7, py); ctx.stroke();
      } else if(p.klass==='assassino'){
        // duas adagas
        ctx.strokeStyle = '#cfd8dc'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(px-p.r*0.9, py-p.r*0.6); ctx.lineTo(px-p.r*0.2, py-1.2*p.r); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px+p.r*0.9, py-p.r*0.6); ctx.lineTo(px+p.r*0.2, py-1.2*p.r); ctx.stroke();
      } else if(p.klass==='lorde'){
        // óculos já são corporais, mas coloco um brilho
        ctx.fillStyle = 'rgba(0,229,255,0.25)'; ctx.beginPath(); ctx.arc(px, py-p.r*0.7, p.r*0.9, Math.PI, 0); ctx.fill();
      } else if(p.klass==='golem'){
        // rachaduras no corpo
        ctx.strokeStyle = 'rgba(30,30,30,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px-p.r*0.6, py-p.r*0.1); ctx.lineTo(px, py+p.r*0.3); ctx.lineTo(px+p.r*0.6, py-p.r*0.2); ctx.stroke();
      } else if(p.klass==='dragonite'){
        // asas (já existia, mas reforço)
        ctx.fillStyle = '#f5b041';
        ctx.beginPath(); ctx.moveTo(px - p.r*1.6, py); ctx.lineTo(px - p.r*0.2, py - p.r*0.6); ctx.lineTo(px - p.r*0.2, py + p.r*0.4); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(px + p.r*1.6, py); ctx.lineTo(px + p.r*0.2, py - p.r*0.6); ctx.lineTo(px + p.r*0.2, py + p.r*0.4); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    function drawCompassHUD(ctx){ const x=64,y=64,r=26; ctx.save(); ctx.translate(x,y); ctx.strokeStyle='#ffffff'; ctx.lineWidth=2; ctx.globalAlpha=0.9; ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(0,r); ctx.moveTo(-r,0); ctx.lineTo(r,0); ctx.stroke(); ctx.fillStyle='#ffffff'; ctx.font='bold 10px system-ui'; ctx.textAlign='center'; ctx.fillText('N',0,-r-6); ctx.fillText('S',0,r+12); ctx.fillText('O',-r-10,4); ctx.fillText('L',r+10,4); ctx.restore(); }

    function drawZoneLabels(ctx, world, cam, vw, vh, sx, sy){ ctx.save(); ctx.globalAlpha=0.06; ctx.fillStyle='#ffffff'; ctx.font='bold 160px system-ui'; ctx.textAlign='center'; const C=[{t:'N',x:world.w/2,y:world.h*0.20},{t:'S',x:world.w/2,y:world.h*0.80},{t:'O',x:world.w*0.20,y:world.h/2},{t:'L',x:world.w*0.80,y:world.h/2},{t:'NE',x:world.w*0.80,y:world.h*0.20},{t:'NO',x:world.w*0.20,y:world.h*0.20},{t:'SE',x:world.w*0.80,y:world.h*0.80},{t:'SO',x:world.w*0.20,y:world.h*0.80}]; for(const c of C){ const vx=c.x-cam.x+sx, vy=c.y-cam.y+sy; if(vx>=-200&&vy>=-200&&vx<=vw+200&&vy<=vh+200) ctx.fillText(c.t,vx,vy);} ctx.restore(); }

    // ===== Loop principal =====
    let last = performance.now();
    function step(now){
      const dt = Math.min(0.033, (now-last)/1000); last=now;
      const snap = latestRef.current; const vw = canvas.width/dpr, vh = canvas.height/dpr;
      // dano -> números
      for(const p of snap.players){ const prev=lastHpRef.current.get(p.id)??p.hp; if(p.hp<prev){ floatsRef.current.push({x:p.x,y:p.y-p.r-18,text:`-${prev-p.hp}`,life:0.9}); if(p.id===myIdRef.current){ shakeRef.current={t:0.20,mag:6}; navigator.vibrate?.(15);} } lastHpRef.current.set(p.id,p.hp); }
      for(const f of floatsRef.current){ f.life-=dt; f.y-=20*dt; } floatsRef.current = floatsRef.current.filter(f=>f.life>0);
      let shakeX=0, shakeY=0; if(shakeRef.current.t>0){ shakeRef.current.t-=dt; const k=shakeRef.current.mag*(shakeRef.current.t/0.20); shakeX=(Math.random()-0.5)*k; shakeY=(Math.random()-0.5)*k; }

      // meu player interpolado
      const meId = myIdRef.current; const meI = meId? getInterpolatedPlayer(meId, performance.now()):null; const me = meI || snap.players.find(p=>p.id===meId) || null;
      updateCamera(me, snap.world, vw, vh);

      // ===== desenhar =====
      // 1) grama texturizada
      drawGrass(ctx, vw, vh);

      // 2) grid leve por cima (como guia)
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth=1; const grid=64; const gx = -((cam.x%grid)+grid)%grid; const gy = -((cam.y%grid)+grid)%grid; for(let x=gx;x<vw;x+=grid){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,vh); ctx.stroke(); } for(let y=gy;y<vh;y+=grid){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(vw,y); ctx.stroke(); }

      // 3) borda do mundo
      ctx.strokeStyle = '#133018'; ctx.lineWidth = 4; ctx.strokeRect(-cam.x+shakeX, -cam.y+shakeY, snap.world.w, snap.world.h);

      // 4) zonas
      drawZoneLabels(ctx, snap.world, cam, vw, vh, shakeX, shakeY);

      // 5) obstáculos como PEDRAS
      for(const ob of snap.obstacles){ drawStoneRect(ctx, ob.x - cam.x + shakeX, ob.y - cam.y + shakeY, ob.w, ob.h); }

      // 6) projéteis
      const klassById = new Map(snap.players.map(p=>[p.id,p.klass]));
      for(const pr of snap.projectiles){ const klass = pr.ownerClass || klassById.get(pr.ownerId); ctx.beginPath(); ctx.fillStyle = (klass==='mago')? '#ff4d4d' : (pr.ownerId===myIdRef.current? '#66e0ff' : '#ff7fb0'); ctx.arc(pr.x - cam.x + shakeX, pr.y - cam.y + shakeY, pr.r, 0, Math.PI*2); ctx.fill(); }

      // 7) companions (drones)
      for(const c of snap.companions||[]){ if(c.type!=='drone') continue; drawTriangle(ctx, c.x - cam.x + shakeX, c.y - cam.y + shakeY, 10, '#9be7ff'); }

      // 8) players (com rosto, braços e acessórios)
      for(const pl of snap.players){ const p = getInterpolatedPlayer(pl.id, performance.now()) || pl; const isMe = p.id===myIdRef.current; const base = isMe? '#4da3ff' : '#7fb5ff'; const alpha = (p.invisLeft||0)>0? 0.35:1;
        // sombra
        ctx.globalAlpha = alpha; ctx.beginPath(); ctx.fillStyle='rgba(0,0,0,0.35)'; ctx.arc(p.x - cam.x + 2 + shakeX, p.y - cam.y + 3 + shakeY, p.r, 0, Math.PI*2); ctx.fill();
        // corpo
        ctx.beginPath(); ctx.fillStyle = base; ctx.arc(p.x - cam.x + shakeX, p.y - cam.y + shakeY, p.r, 0, Math.PI*2); ctx.fill(); ctx.globalAlpha=1;
        // face + braços
        drawFaceAndArms(ctx, p.x - cam.x + shakeX, p.y - cam.y + shakeY, p.r);
        // chapéus originais leves + acessórios
        drawHeadgear(ctx, p, cam, shakeX, shakeY); // reaproveita chapéus anteriores
        drawAccessory(ctx, p, p.x - cam.x + shakeX, p.y - cam.y + shakeY, base);
        // giro guerreiro (anel)
        if(p.klass==='guerreiro' && (p.spinLeft||0)>0){ ctx.strokeStyle='rgba(255,255,255,0.35)'; ctx.lineWidth=2; ctx.setLineDash([8,6]); ctx.beginPath(); ctx.arc(p.x - cam.x + shakeX, p.y - cam.y + shakeY, p.r + 26, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]); }
        // barras e nome
        drawHpBar(ctx, p.x - cam.x + shakeX, p.y - cam.y - p.r - 12 + shakeY, 56, 8, p.hp/p.maxHp);
        ctx.fillStyle='#d9ecff'; ctx.font='bold 13px system-ui, Arial'; ctx.textAlign='center'; ctx.fillText(p.nickname||'Soldado', p.x - cam.x + shakeX, p.y - cam.y - p.r - 22 + shakeY);
      }

      // alvo travado (me)
      if(me && me.targetId){ const tgt = getInterpolatedPlayer(me.targetId, performance.now()) || snap.players.find(p=>p.id===me.targetId); if(tgt){ ctx.strokeStyle='#ffdd57'; ctx.lineWidth=3; ctx.setLineDash([6,6]); ctx.beginPath(); ctx.arc(tgt.x - cam.x + shakeX, tgt.y - cam.y + shakeY, tgt.r+10, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]); ctx.strokeStyle='rgba(255,221,87,0.5)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(me.x - cam.x + shakeX, me.y - cam.y + shakeY); ctx.lineTo(tgt.x - cam.x + shakeX, tgt.y - cam.y + shakeY); ctx.stroke(); } }

      // números flutuantes
      for(const f of floatsRef.current){ ctx.globalAlpha=Math.max(0,f.life); ctx.fillStyle='#ff6b6b'; ctx.font='bold 14px system-ui, Arial'; ctx.textAlign='center'; ctx.fillText(f.text, f.x - cam.x + shakeX, f.y - cam.y + shakeY); ctx.globalAlpha=1; }

      // HUD básicos
      const myHp = me?.hp ?? 100; setHud({ hp:myHp, players:snap.players.length, nickname: me?.nickname || ui.nickname || 'Soldado' });

      // rosa dos ventos fixa
      drawCompassHUD(ctx);

      requestAnimationFrame(step);
    }
    const raf = requestAnimationFrame(step);

    return ()=>{ socket.disconnect(); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', onPointerDown); window.removeEventListener('resize', resize); document.body.style.overflow = prevOverflow; };
  }, [ui.started]);

  // ====== Helpers visuais compartilhados ======
  function drawTriangle(ctx,x,y,r,color){ ctx.fillStyle=color; ctx.beginPath(); ctx.moveTo(x, y-r); ctx.lineTo(x-r*0.9, y+r*0.8); ctx.lineTo(x+r*0.9, y+r*0.8); ctx.closePath(); ctx.fill(); }
  function drawHeadgear(ctx, p, cam, sx=0, sy=0){ const x=p.x - cam.x + sx, y=p.y - cam.y + sy, r=p.r; ctx.save(); if(p.klass==='arqueiro'){ ctx.fillStyle='#2ecc71'; ctx.beginPath(); ctx.moveTo(x - r * 0.9, y - r * 1.15); ctx.lineTo(x + r * 0.6, y - r * 1.6); ctx.lineTo(x + r * 0.9, y - r * 1.0); ctx.closePath(); ctx.fill(); ctx.strokeStyle='#27ae60'; ctx.lineWidth=2; ctx.stroke(); ctx.strokeStyle='#27ae60'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(x - r*0.8, y - r*0.9); ctx.lineTo(x + r*0.9, y - r*0.9); ctx.stroke(); } else if(p.klass==='guerreiro'){ ctx.fillStyle='#bdc3c7'; ctx.beginPath(); ctx.arc(x, y - r*0.9, r*0.95, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.fillStyle='#95a5a6'; ctx.fillRect(x - r*0.9, y - r*0.9, r*1.8, 4); } else if(p.klass==='mago'){ ctx.fillStyle='#8e44ad'; ctx.beginPath(); ctx.moveTo(x, y - r * 2.0); ctx.lineTo(x - r * 0.9, y - r * 0.8); ctx.lineTo(x + r * 0.9, y - r * 0.8); ctx.closePath(); ctx.fill(); ctx.fillStyle='#6c3483'; ctx.fillRect(x - r*1.0, y - r*0.8, r*2.0, 4); } else if(p.klass==='assassino'){ ctx.fillStyle='#2c3e50'; ctx.beginPath(); ctx.moveTo(x - r*1.0, y - r*0.6); ctx.lineTo(x, y - r*1.6); ctx.lineTo(x + r*1.0, y - r*0.6); ctx.closePath(); ctx.fill(); } else if(p.klass==='lorde'){ ctx.fillStyle='#00e5ff'; ctx.fillRect(x - r*0.7, y - r*0.9, r*1.4, 6); } else if(p.klass==='golem'){ ctx.strokeStyle='#7f8c8d'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke(); } else if(p.klass==='dragonite'){ ctx.fillStyle='#f5b041'; ctx.beginPath(); ctx.moveTo(x - r*1.6, y); ctx.lineTo(x - r*0.2, y - r*0.6); ctx.lineTo(x - r*0.2, y + r*0.4); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(x + r*1.6, y); ctx.lineTo(x + r*0.2, y - r*0.6); ctx.lineTo(x + r*0.2, y + r*0.4); ctx.closePath(); ctx.fill(); } ctx.restore(); }

  // ====== Tela inicial ANIMADA ======
  useEffect(()=>{
    if(ui.started) return; // animação só na tela inicial
    const bg = bgRef.current; if(!bg) return; const g = bg.getContext('2d');
    function resizeBG(){ bg.width = window.innerWidth; bg.height = window.innerHeight; }
    resizeBG(); window.addEventListener('resize', resizeBG);
    let t=0, raf=0;
    function loop(){ t+=0.016; const w=bg.width, h=bg.height; // fundo animado com "bolhas" verdes
      g.clearRect(0,0,w,h);
      const grd = g.createLinearGradient(0,0,w,h); grd.addColorStop(0,'#0d1f12'); grd.addColorStop(1,'#173822'); g.fillStyle=grd; g.fillRect(0,0,w,h);
      for(let i=0;i<14;i++){ const r=80+((i*13)%120); const x = (Math.sin(t*0.3+i)*0.5+0.5)*w; const y=(Math.cos(t*0.25+i*0.7)*0.5+0.5)*h; const grad=g.createRadialGradient(x,y,0,x,y,r); grad.addColorStop(0, 'rgba(60,140,80,0.25)'); grad.addColorStop(1,'rgba(0,0,0,0)'); g.fillStyle=grad; g.beginPath(); g.arc(x,y,r,0,Math.PI*2); g.fill(); }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return ()=>{ cancelAnimationFrame(raf); window.removeEventListener('resize', resizeBG); };
  }, [ui.started]);

  const handleStart = ()=>{ if(!(ui.nickname||'').trim()){ alert('Digite um nickname'); return; } setUi(s=>({...s, started:true})); };
  const handleRespawn = ()=> socketRef.current?.emit('respawn');

  // estilos inline p/ botões animados
  const btnStyle = (active)=>({
    padding:'10px 14px', borderRadius:12, cursor:'pointer', border:'2px solid '+(active?'#7CFC7C':'#2d4a36'),
    background: active? 'linear-gradient(140deg,#1f6b3a,#2e8b57)' : 'linear-gradient(140deg,#0f2316,#14301e)',
    color:'#e8ffe8', fontWeight:600, boxShadow: active? '0 0 12px rgba(100,255,120,0.3)' : '0 0 6px rgba(0,0,0,0.4)',
    transform: active? 'translateY(-1px) scale(1.02)' : 'translateY(0)', transition:'all .15s ease'
  });

  return (
    <div style={{position:'relative', width:'100vw', height:'100vh', background:'#0b0f1a', overflow:'hidden'}}>
      <canvas ref={canvasRef} style={{display: ui.started? 'block':'none', width:'100%', height:'100%'}} />

      {/* Tela inicial melhorada */}
      {!ui.started && (
        <div style={{position:'absolute', inset:0}}>
          <canvas ref={bgRef} style={{position:'absolute', inset:0}} />
          <div style={{position:'absolute', inset:0, display:'grid', placeItems:'center', pointerEvents:'none'}}>
            <div style={{width:'min(92vw, 760px)', pointerEvents:'auto', color:'#e9ffe9'}}>
              <div style={{textAlign:'center', marginBottom:16}}>
                <h1 style={{margin:0, fontSize:28, letterSpacing:1}}>Clicker de Guerra — PvP</h1>
                <p style={{margin:'8px 0 0', opacity:.85}}>Planície verde, batalhas rápidas e habilidades com estilo.</p>
              </div>

              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, alignItems:'center', marginTop:12}}>
                <label style={{fontSize:14, opacity:.9}}>Nickname</label>
                <input value={ui.nickname} onChange={(e)=>setUi(s=>({...s, nickname:e.target.value}))} maxLength={16}
                  placeholder="Seu nickname" style={{padding:'10px 12px', borderRadius:10, outline:'none', border:'2px solid #2d4a36', background:'#0e2115', color:'#e8ffe8'}}/>
              </div>

              <div style={{marginTop:14, fontSize:14, opacity:.9}}>Classe</div>
              <div style={{display:'grid', gridTemplateColumns:'repeat(7, minmax(0,1fr))', gap:8, marginTop:8}}>
                {['arqueiro','guerreiro','mago','assassino','lorde','golem','dragonite'].map(k => (
                  <div key={k} onClick={()=>setUi(s=>({...s, klass:k}))} style={btnStyle(ui.klass===k)}>{k}</div>
                ))}
              </div>

              <div style={{display:'flex', gap:12, marginTop:18, justifyContent:'space-between'}}>
                <button onClick={handleStart} style={{...btnStyle(true), flex:1}}>Começar</button>
                <div style={{...btnStyle(false), flex:1, textAlign:'center', opacity:.9}}>Servidor: <span style={{opacity:.9}}>{SERVER_URL}</span></div>
              </div>
              <div style={{marginTop:8, fontSize:12, opacity:.7}}>Dica: Toque para mover • Toque em um jogador para focar • Double tap = habilidade</div>
            </div>
          </div>
        </div>
      )}

      {/* HUD simples quando está no jogo */}
      {ui.started && (
        <div style={{position:'absolute', left:12, top:12, background:'rgba(0,0,0,0.45)', color:'#fff', padding:'8px 10px', borderRadius:12, pointerEvents:'none'}}>
          <div style={{fontSize:13}}>HP: <b>{Math.max(0, Math.floor(hud.hp))}</b> • Jogadores: <b>{hud.players}</b></div>
          <div style={{fontSize:12, opacity:.8}}>Você: {hud.nickname || ui.nickname}</div>
        </div>
      )}

      {ui.started && (
        <div style={{position:'absolute', right:12, bottom:12}}>
          <button onClick={handleRespawn} style={{padding:'10px 14px', borderRadius:12, background:'#2e8b57', color:'#fff', border:'2px solid #7CFC7C', cursor:'pointer'}}>Respawn</button>
        </div>
      )}
    </div>
  );
}
