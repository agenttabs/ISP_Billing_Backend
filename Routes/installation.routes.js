const express = require("express");

const controller = require("../controller/installation.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/installations",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getInstallations
);

router.post(
  "/installations",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.saveInstallation
);

router.put(
  "/installations/:id",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.saveInstallation
);

module.exports = router;
