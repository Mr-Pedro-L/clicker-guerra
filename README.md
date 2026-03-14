
# Clicker de Guerra — Multiplayer (Co-op vs IA)

Este repositório contém **servidor** (Node + Socket.IO) e **cliente** (React + Vite).

## Rodar local

```bash
# terminal 1 — servidor
cd server
npm i
npm start   # http://localhost:3000

# terminal 2 — cliente
cd client
cp .env.example .env   # (opcional) já aponta para http://localhost:3000
npm i
npm run dev            # abre o link (ex.: http://localhost:5173)
```

Abra o cliente em duas abas/dispositivos e jogue co‑op.

## Publicar online

### 1) Servidor (Render)
- Crie um Web Service apontando para a pasta `server/`.
- **Start Command:** `node server.js`
- Ao finalizar, anote a URL (ex.: `https://seu-servidor.onrender.com`).

### 2) Cliente (Vercel)
- Projeto apontando para a pasta `client/`.
- Adicione a env `VITE_SERVER_URL` com a URL do servidor Render.
- Deploy. Compartilhe a URL da Vercel com seus amigos.

> Dica: se preferir 1 domínio só, faça build do cliente e copie `client/dist` para `server/public` (o Express já serve estático). No Render: Root dir `server`, Build command pode rodar o build do cliente e copiar os arquivos.
