const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",  // allow all (change later for security)
    methods: ["GET", "POST"]
  }
});

let waitingUser = null;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("findPartner", () => {
    if (!waitingUser) {
      waitingUser = socket;
      console.log("User waiting:", socket.id);
    } else {
      // Pair the two users
      const partner = waitingUser;
      waitingUser = null;

      socket.partner = partner;
      partner.partner = socket;

      socket.emit("match", partner.id);
      partner.emit("match", socket.id);

      console.log(`Paired: ${socket.id} <-> ${partner.id}`);
    }
  });

  socket.on("offer", (offer) => {
    if (socket.partner) socket.partner.emit("offer", offer);
  });

  socket.on("answer", (answer) => {
    if (socket.partner) socket.partner.emit("answer", answer);
  });

  socket.on("candidate", (candidate) => {
    if (socket.partner) socket.partner.emit("candidate", candidate);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    if (waitingUser?.id === socket.id) waitingUser = null;

    if (socket.partner) {
      socket.partner.emit("partnerLeft");
      socket.partner.partner = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
