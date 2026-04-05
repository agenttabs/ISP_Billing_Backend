const express = require("express");
const router = express.Router();
const { getUsers, createUser } = require("../Controller/test.controller");

// GET
router.get("/", getUsers);

// POST
router.post("/", createUser);

module.exports = router;