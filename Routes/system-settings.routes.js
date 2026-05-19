const express = require("express");

const controller = require("../controller/system-settings.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/system-settings",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getSystemSettings
);

router.put(
  "/system-settings",
  protect,
  authorize("ADMIN"),
  controller.saveSystemSettings
);

module.exports = router;
