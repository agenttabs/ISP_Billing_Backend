let ioInstance = null;

const initRealtime = (server) => {
  const { Server } = require("socket.io");

  ioInstance = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  ioInstance.on("connection", (socket) => {
    console.log("SOCKET CONNECTED:", socket.id);

    socket.on("disconnect", () => {
      console.log("SOCKET DISCONNECTED:", socket.id);
    });
  });

  return ioInstance;
};

const getIo = () => ioInstance;

const emitClientsChanged = (payload = {}) => {
  if (!ioInstance) {
    return false;
  }

  ioInstance.emit("clients:changed", {
    at: new Date().toISOString(),
    ...payload
  });

  return true;
};

module.exports = {
  initRealtime,
  getIo,
  emitClientsChanged
};
