const express = require("express");

const controller = require("../controller/olt-dump-scheduler.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/olt-dump-scheduler/config",
  protect,
  authorize("ADMIN"),
  controller.getOltDumpSchedulerConfig
);

router.put(
  "/olt-dump-scheduler/config",
  protect,
  authorize("ADMIN"),
  controller.saveOltDumpSchedulerConfig
);

router.post(
  "/olt-dump-scheduler/run-now",
  protect,
  authorize("ADMIN"),
  controller.runOltDumpNow
);

module.exports = router;
