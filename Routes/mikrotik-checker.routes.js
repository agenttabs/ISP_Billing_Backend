const express = require("express");

const controller = require("../controller/mikrotik-checker.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/mikrotik-checker/config",
  protect,
  authorize("ADMIN"),
  controller.getMikrotikCheckerConfig
);

router.put(
  "/mikrotik-checker/config",
  protect,
  authorize("ADMIN"),
  controller.saveMikrotikCheckerConfig
);

router.get(
  "/mikrotik-checker/report",
  protect,
  authorize("ADMIN"),
  controller.runMikrotikChecker
);

router.post(
  "/mikrotik-checker/run-now",
  protect,
  authorize("ADMIN"),
  controller.runMikrotikCheckerEmailNow
);

module.exports = router;
