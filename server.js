/* server.js - Advanced signaling server for random video chat
   Features:
   - initiator flag on match
   - prevents self-match & immediate re-pairing with same partner
   - support for "next", "report", "heartbeat"
   - in-memory rate limiting for abuse prevention
   - basic ban list and report storage (in-memory)
   - ready to extend for Redis persistence / DB
*/

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // in production change to your domain
    methods: ["GET", "POST"]
  }
});

// Global state
let waitingUser = null;
const activeUsers = new Map();      // socket.id -> socket
const recentPairs = new Map();      // socket.id -> Set of recently paired partner ids (avoid immediate rematch)
const reports = [];                 // { reporterId, reportedId, reason, ts }
const banned = new Set();           // banned socket ids / user identifiers
const RATE_LIMIT = new Map();       // simple rate limit map for actions

// Helpers
function now() { return Date.now(); }
function markRateLimited(id, action, ms = 1000) {
  const key = `${id}:${action}`;
  const last = RATE_LIMIT.get(key) || 0;
  if (now() - last < ms) return true;
  RATE_LIMIT.set(key, now());
  return false;
}

function safeDisconnect(socket) {
  if (!socket) return;
  console.log("Cleaning user:", socket.id);

  if (waitingUser && waitingUser.id === socket.id) waitingUser = null;

  if (socket.partner) {
    try {
      socket.partner.emit("partnerLeft");
      socket.partner.partner = null;
    } catch (e) {}
  }

  socket.partner = null;
  activeUsers.delete(socket.id);
  recentPairs.delete(socket.id);
}

// Avoid immediate re-pairing between same two sockets
function recordPair(a, b) {
  if (!recentPairs.has(a)) recentPairs.set(a, new Set());
  if (!recentPairs.has(b)) recentPairs.set(b, new Set());
  recentPairs.get(a).add(b);
  recentPairs.get(b).add(a);
  // schedule clearing after some time (e.g., 60s)
  setTimeout(() => {
    recentPairs.get(a)?.delete(b);
    recentPairs.get(b)?.delete(a);
  }, 60000);
}

// Check if two sockets were recently paired
function wasRecentlyPaired(a, b) {
  return recentPairs.get(a)?.has(b) || false;
}

// Connection
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  activeUsers.set(socket.id, socket);
  socket.partner = null;
  socket.lastSeen = now();

  socket.on("heartbeat", () => socket.lastSeen = now());

  // REPORT
  socket.on("report", (payload) => {
    if (!payload) return;
    if (markRateLimited(socket.id, "report", 5000)) return;
    const reportedId = socket.partner?.id || payload.reportedId;
    const reason = payload.reason || "unspecified";
    const entry = { reporterId: socket.id, reportedId, reason, ts: now() };
    reports.push(entry);
    console.log("Report stored:", entry);
    // simple action: notify reporter
    socket.emit("reportAck", "Thank you. We'll review the report.");
    // optionally ban repeated offenders
    const reportCount = reports.filter(r => r.reportedId === reportedId).length;
    if (reportCount >= 3 && reportedId) {
      banned.add(reportedId);
      io.to(reportedId).emit("banned", "Multiple reports");
    }
  });

  // FIND PARTNER
  socket.on("findPartner", (meta) => {
    if (banned.has(socket.id)) {
      socket.emit("banned", "You are banned");
      return;
    }

    if (markRateLimited(socket.id, "findPartner", 800)) {
      socket.emit("matchTimeout", "Please wait briefly");
      return;
    }

    // Prevent self-matching
    if (waitingUser && waitingUser.id === socket.id) return;

    // If no waiting user, set this socket as waiting
    if (!waitingUser) {
      waitingUser = socket;
      console.log("User waiting:", socket.id);
      return;
    }

    // If there is a waiting user, attempt to pair (avoid recent pairs)
    if (waitingUser && waitingUser.id !== socket.id) {
      const partner = waitingUser;

      if (wasRecentlyPaired(socket.id, partner.id)) {
        // If recently paired, keep waiting and try again later
        console.log("Recently paired, keeping in queue:", socket.id);
        return;
      }

      // Clear waitingUser BEFORE pairing to avoid race
      waitingUser = null;

      socket.partner = partner;
      partner.partner = socket;

      // Record pair to avoid immediate re-pair
      recordPair(socket.id, partner.id);

      // initiator: socket (the one who called findPartner second) will create offer
      socket.emit("match", { initiator: true, partnerId: partner.id });
      partner.emit("match", { initiator: false, partnerId: socket.id });

      console.log(`Paired: ${socket.id} <-> ${partner.id}`);
    }
  });

  // OFFER / ANSWER / CANDIDATE relays (simple passthrough)
  socket.on("offer", (offer) => {
    if (socket.partner) {
      socket.partner.emit("offer", offer);
    }
  });

  socket.on("answer", (answer) => {
    if (socket.partner) {
      socket.partner.emit("answer", answer);
    }
  });

  socket.on("candidate", (candidate) => {
    if (socket.partner) {
      socket.partner.emit("candidate", candidate);
    }
  });

  // NEXT - break current pair and requeue
  socket.on("next", () => {
    if (markRateLimited(socket.id, "next", 1000)) return;
    if (socket.partner) {
      try {
        socket.partner.emit("partnerLeft");
        socket.partner.partner = null;
      } catch (e) {}
      socket.partner = null;
    }
    // Put the requester back into findPartner flow immediately
    socket.emit("readyForNext");
    socket.emit("findPartner");
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    safeDisconnect(socket);
  });
});

// Periodic cleanup of stale sockets
setInterval(() => {
  const cutoff = now() - 45000; // 45s
  for (const [id, socket] of activeUsers.entries()) {
    if (socket.lastSeen < cutoff) {
      console.log("Removing inactive user:", id);
      safeDisconnect(socket);
    }
  }
}, 20000);

// Basic admin endpoint (optional) to inspect reports (not exposed in production)
app.get("/__admin/reports", (req, res) => {
  res.json({ reports, banned: Array.from(banned) });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on ${PORT}`));
