const express = require("express");

const controller = require("../controller/repair.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/repairs",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getRepairs
);

router.put(
  "/repairs/:id/status",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.updateRepairStatus
);

module.exports = router;
