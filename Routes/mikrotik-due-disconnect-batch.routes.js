const express = require("express");

const controller = require("../controller/mikrotik-due-disconnect-batch.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/mikrotik-due-disconnect-batch/config",
  protect,
  authorize("ADMIN"),
  controller.getMikrotikDueDisconnectBatchConfig
);

router.put(
  "/mikrotik-due-disconnect-batch/config",
  protect,
  authorize("ADMIN"),
  controller.saveMikrotikDueDisconnectBatchConfig
);

router.get(
  "/mikrotik-due-disconnect-batch/report",
  protect,
  authorize("ADMIN"),
  controller.previewMikrotikDueDisconnectBatch
);

router.post(
  "/mikrotik-due-disconnect-batch/run-now",
  protect,
  authorize("ADMIN"),
  controller.runMikrotikDueDisconnectBatchNow
);

module.exports = router;
