const express = require("express");

const controller = require("../controller/system.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/system/diagnostics",
  protect,
  authorize("ADMIN"),
  controller.getDiagnostics
);

router.get(
  "/system/logs",
  protect,
  authorize("ADMIN"),
  controller.getSystemLogs
);

module.exports = router;
