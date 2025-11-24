const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Queue of waiting users
let waitingUser = null;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.partner = null;

  socket.on("findPartner", () => {
    // Prevent self-matching
    if (waitingUser && waitingUser.id === socket.id) return;

    // If no one is waiting, put this user in queue
    if (!waitingUser) {
      waitingUser = socket;
      console.log("User waiting:", socket.id);
      return;
    }

    // If someone is already waiting → pair them
    if (waitingUser && waitingUser.id !== socket.id) {
      const partner = waitingUser;

      // Clear waiting slot BEFORE pairing (prevents double-match)
      waitingUser = null;

      socket.partner = partner;
      partner.partner = socket;

      socket.emit("match", partner.id);
      partner.emit("match", socket.id);

      console.log(`Paired: ${socket.id} <-> ${partner.id}`);
    }
  });

  socket.on("offer", (offer) => {
    if (socket.partner)
      socket.partner.emit("offer", offer);
  });

  socket.on("answer", (answer) => {
    if (socket.partner)
      socket.partner.emit("answer", answer);
  });

  socket.on("candidate", (candidate) => {
    if (socket.partner)
      socket.partner.emit("candidate", candidate);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // If this user was waiting, remove them
    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }

    // If this user had a partner, notify and unlink
    if (socket.partner) {
      socket.partner.emit("partnerLeft");
      socket.partner.partner = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
