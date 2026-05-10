const express = require("express");
const router = express.Router();
const Client = require("../Model/client.model");

// GET all clients
router.get("/", async (req, res) => {
  const clients = await Client.find();
  res.json(clients);
});

module.exports = router;



