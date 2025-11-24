const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ===============================
//   ADVANCED SIGNALING SERVER
// ===============================
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Perfect matching queue
let waitingUser = null;

// Track users explicitly
const activeUsers = new Map();

// CLEANUP function
function safeDisconnect(socket) {
  console.log("Cleaning user:", socket.id);

  // Remove from waiting queue
  if (waitingUser && waitingUser.id === socket.id) {
    waitingUser = null;
  }

  // Remove partner link
  if (socket.partner) {
    socket.partner.emit("partnerLeft");
    socket.partner.partner = null;
  }

  socket.partner = null;
  activeUsers.delete(socket.id);
}

// ==============================================
//          NEW CONNECTION
// ==============================================
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  activeUsers.set(socket.id, socket);

  socket.partner = null;
  socket.lastSeen = Date.now();

  // Heartbeat check
  socket.on("heartbeat", () => {
    socket.lastSeen = Date.now();
  });

  // ====================================
  //        FIND PARTNER (MATCHING)
  // ====================================
  socket.on("findPartner", () => {
    console.log("findPartner from:", socket.id);

    // If waitingUser is same user → ignore
    if (waitingUser && waitingUser.id === socket.id) return;

    // No one waiting → add this user
    if (!waitingUser) {
      waitingUser = socket;
      console.log("User waiting:", socket.id);
      return;
    }

    // Another user is waiting → pair them
    if (waitingUser && waitingUser.id !== socket.id) {
      const partner = waitingUser;

      waitingUser = null;

      socket.partner = partner;
      partner.partner = socket;

      // IMPORTANT — initiator logic
      socket.emit("match", { initiator: true, partnerId: partner.id });
      partner.emit("match", { initiator: false, partnerId: socket.id });

      console.log(`Paired: ${socket.id} <-> ${partner.id}`);
    }
  });

  // ====================================
  //             OFFER
  // ====================================
  socket.on("offer", (offer) => {
    if (socket.partner) {
      socket.partner.emit("offer", offer);
    }
  });

  // ====================================
  //             ANSWER
  // ====================================
  socket.on("answer", (answer) => {
    if (socket.partner) {
      socket.partner.emit("answer", answer);
    }
  });

  // ====================================
  //             ICE CANDIDATES
  // ====================================
  socket.on("candidate", (candidate) => {
    if (socket.partner) {
      socket.partner.emit("candidate", candidate);
    }
  });

  // ====================================
  //             NEXT BUTTON
  // ====================================
  socket.on("next", () => {
    console.log("User wants next:", socket.id);

    if (socket.partner) {
      socket.partner.emit("partnerLeft");
      socket.partner.partner = null;
      socket.partner = null;
    }

    // Immediately search again
    socket.emit("readyForNext");
    socket.emit("findPartner");
  });

  // ====================================
  //             DISCONNECT
  // ====================================
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    safeDisconnect(socket);
  });
});


// ====================================
//  DEAD USER CLEANER EVERY 20 SECONDS
// ====================================
setInterval(() => {
  const now = Date.now();
  activeUsers.forEach((user) => {
    if (now - user.lastSeen > 30000) {
      console.log("Removing inactive:", user.id);
      safeDisconnect(user);
    }
  });
}, 20000);


// ====================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
