const express = require("express");

const controller = require("../controller/olt-lookup.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/olt-lookup",
  protect,
  authorize("ADMIN"),
  controller.lookupOltClient
);

module.exports = router;
