import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  const PORT = 3000;

  // Store connected clients and their player IDs
  const clients = new Map<WebSocket, string>();
  let nextPlayerId = 'blue';

  wss.on("connection", (ws) => {
    const playerId = nextPlayerId;
    nextPlayerId = nextPlayerId === 'blue' ? 'red' : 'blue';
    clients.set(ws, playerId);

    console.log(`Player ${playerId} connected`);

    // Send initial assignment
    ws.send(JSON.stringify({ type: 'init', playerId }));

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        // Broadcast to all other clients
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
          }
        });
      } catch (e) {
        console.error("Failed to parse message", e);
      }
    });

    ws.on("close", () => {
      console.log(`Player ${playerId} disconnected`);
      clients.delete(ws);
      // If a player disconnects, reset the next assignment if no one is left
      if (clients.size === 0) {
        nextPlayerId = 'blue';
      }
      // Notify others
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'disconnect', playerId }));
        }
      });
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
